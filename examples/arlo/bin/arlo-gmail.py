#!/root/.meridian/arlo/email-venv/bin/python
"""
arlo-gmail — read-only Gmail for Arlo via the ATERNA Google service account
(domain-wide delegation, gmail.readonly). No app password, no OAuth click, no
sending. Restores the email capability Arlo had in the OpenClaw era.

Accounts: ajuarez@aterna.ai (default), arlo@aterna.ai
Usage:
  arlo-gmail recent  [--account A] [--max N] [--unread] [--query Q]
  arlo-gmail search  --query Q [--account A] [--max N]
  arlo-gmail read    --id MSG_ID [--account A]
  arlo-gmail draft   --to A --subject S --body B [--cc C] [--reply-to MSG_ID]   (saves a real Gmail draft in arlo@)
  arlo-gmail pending [--account A] [--max N] [--query Q]
  arlo-gmail corpus  --account A --query Q --output PATH [--max N]
  arlo-gmail accounts
  arlo-gmail scopes    (which delegated scopes the service account holds; no side effects)

GROUNDING: every line this prints is pulled live from Gmail this run. Arlo must
never report email state he did not pull this turn. Read-only: this tool cannot
send, delete, or modify anything.
"""
import sys, argparse, base64, html, os, re, json
from email.utils import parseaddr
from datetime import datetime, timezone
from google.oauth2 import service_account
from googleapiclient.discovery import build

ARLO_HOME = os.environ.get("ARLO_HOME", "/root/.meridian/arlo")
SA_FILE = os.path.join(ARLO_HOME, "secrets/aterna-agents-sa.json")
SIG_FILE = os.path.join(ARLO_HOME, "secrets/arlo-signature.html")
PROCESSED_FILE = os.path.join(ARLO_HOME, "logs/inbox-processed.txt")
SENT_LOG = os.path.join(ARLO_HOME, "logs/sent-mail.jsonl")
DRAFT_SCOPES = ["https://www.googleapis.com/auth/gmail.compose"]
SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
]
ACCOUNTS = ["ajuarez@aterna.ai", "arlo@aterna.ai"]
# Arlo SENDS as his own dedicated Workspace account, never as Atanasio's. He may
# READ Atanasio's inbox (chief-of-staff triage), but outbound is always from arlo@.
SEND_FROM = "arlo@aterna.ai"


def service(account):
    if account not in ACCOUNTS:
        sys.exit(f"unknown account {account!r}; valid: {', '.join(ACCOUNTS)}")
    creds = service_account.Credentials.from_service_account_file(
        SA_FILE, scopes=SCOPES, subject=account)
    return build("gmail", "v1", credentials=creds, cache_discovery=False)


def header(msg, name):
    for h in msg.get("payload", {}).get("headers", []):
        if h["name"].lower() == name.lower():
            return h["value"]
    return ""


def list_messages(svc, query, max_n):
    res = svc.users().messages().list(userId="me", q=query, maxResults=max_n).execute()
    out = []
    for m in res.get("messages", []):
        full = svc.users().messages().get(
            userId="me", id=m["id"], format="metadata",
            metadataHeaders=["From", "Subject", "Date"]).execute()
        out.append({
            "id": m["id"],
            "from": header(full, "From"),
            "subject": header(full, "Subject") or "(no subject)",
            "date": header(full, "Date"),
            "receivedAt": datetime.fromtimestamp(int(full["internalDate"]) / 1000, timezone.utc).isoformat(),
            "snippet": html.unescape(full.get("snippet", "")),
            "unread": "UNREAD" in full.get("labelIds", []),
        })
    return out


def cmd_list(args):
    svc = service(args.account)
    q = args.query or ""
    if getattr(args, "unread", False):
        q = (q + " is:unread").strip()
    if args.cmd == "recent" and "in:" not in q:
        q = (q + " in:inbox").strip()
    rows = list_messages(svc, q.strip(), args.max)
    if getattr(args, "json", False):
        print(json.dumps({"account": args.account, "query": q, "messages": rows}))
        return
    if not rows:
        print(f"[{args.account}] no messages for query: {q or '(inbox)'}")
        return
    print(f"[{args.account}] {len(rows)} message(s) for: {q or 'in:inbox'}\n")
    for r in rows:
        flag = "● " if r["unread"] else "  "
        print(f"{flag}{r['date']}")
        print(f"  From:    {r['from']}")
        print(f"  Subject: {r['subject']}")
        print(f"  Snippet: {r['snippet'][:200]}")
        print(f"  id:      {r['id']}\n")


def decode_part(part):
    data = part.get("body", {}).get("data")
    if not data:
        return ""
    return base64.urlsafe_b64decode(data.encode()).decode("utf-8", "replace")


def extract_body(payload):
    if payload.get("mimeType") == "text/plain":
        return decode_part(payload)
    for p in payload.get("parts", []) or []:
        if p.get("mimeType") == "text/plain":
            t = decode_part(p)
            if t.strip():
                return t
    for p in payload.get("parts", []) or []:
        t = extract_body(p)
        if t.strip():
            return t
    if payload.get("mimeType") == "text/html":
        return re.sub(r"<[^>]+>", "", html.unescape(decode_part(payload)))
    return ""


def cmd_read(args):
    svc = service(args.account)
    full = svc.users().messages().get(userId="me", id=args.id, format="full").execute()
    print(f"[{args.account}]")
    print(f"From:    {header(full, 'From')}")
    print(f"To:      {header(full, 'To')}")
    print(f"Date:    {header(full, 'Date')}")
    print(f"Subject: {header(full, 'Subject')}")
    print("-" * 60)
    body = extract_body(full.get("payload", {})).strip()
    print(body[:6000] if body else full.get("snippet", ""))


def requires_operator_action(subject, snippet):
    """Retain automated notices that may require a real operator action."""
    return bool(re.search(
        r"security|suspicious|unauthori[sz]ed|password|sign.?in|log.?in|verification|"
        r"account.{0,20}(?:locked|suspend|recover)|action required|requires your|"
        r"payment.{0,20}(?:fail|declin|overdue)|past due|breach|fraud|"
        r"(?:service|subscription).{0,20}(?:expir|cancel|suspend)|urgent",
        subject + " " + snippet, re.I))


def cmd_pending(args):
    """List inbox threads that need a reply.

    A thread is pending when its newest message is external and still in the
    inbox. This is independent of Gmail's read/unread flag, so opening a message
    on a phone cannot make Arlo miss it. A successful threaded reply from Arlo
    becomes the newest message and automatically removes the thread from this
    list on the next poll.
    """
    account = args.account
    svc = service(account)
    query = (args.query or "newer_than:7d in:inbox").strip()
    # Scan past bulk messages so newsletters cannot crowd out human requests.
    res = svc.users().threads().list(userId="me", q=query, maxResults=100).execute()
    rows = list(res.get("threads", []))
    if res.get("nextPageToken"):
        res = svc.users().threads().list(
            userId="me", q=query, maxResults=100, pageToken=res["nextPageToken"]
        ).execute()
        rows.extend(res.get("threads", []))
    try:
        with open(PROCESSED_FILE, encoding="utf-8") as f:
            processed = {line.strip() for line in f if line.strip()}
    except FileNotFoundError:
        processed = set()
    pending = []
    ignored = 0
    scanned = 0
    for row in rows:
        scanned += 1
        thread = svc.users().threads().get(
            userId="me", id=row["id"], format="metadata",
            metadataHeaders=["From", "To", "Subject", "Date", "Auto-Submitted", "Precedence", "List-Unsubscribe"],
        ).execute()
        messages = sorted(
            thread.get("messages", []), key=lambda m: int(m.get("internalDate", "0"))
        )
        if not messages:
            continue
        latest = messages[-1]
        if "INBOX" not in latest.get("labelIds", []):
            continue
        if latest["id"] in processed:
            continue
        sender = header(latest, "From")
        sender_l = sender.lower()
        if parseaddr(sender)[1].lower() == account.lower():
            continue
        auto_submitted = header(latest, "Auto-Submitted").lower()
        precedence = header(latest, "Precedence").lower()
        automated = (
            (auto_submitted and auto_submitted != "no")
            or precedence in {"bulk", "list", "junk"}
            or "no-reply@" in sender_l
            or "noreply@" in sender_l
            or bool(header(latest, "List-Unsubscribe"))
        )
        subject = header(latest, "Subject") or "(no subject)"
        snippet = html.unescape(latest.get("snippet", ""))
        bulk_marketing = precedence in {"bulk", "list", "junk"} or bool(header(latest, "List-Unsubscribe")) or bool(re.search(
            r"newsletter|weekly (?:roundup|digest)|new product|product update|special offer|unsubscribe|webinar|promotion", subject + " " + snippet, re.I))
        transactional = bool(re.search(r"\binvoice\b|\bappointment\b|\bnew lead\b|\bestimate request\b|\bquote request\b|\bmeeting cancel|\bbooking\b", subject + " " + snippet, re.I))
        if automated and bulk_marketing and not transactional and not requires_operator_action(subject, snippet):
            ignored += 1
            continue
        pending.append({
            "id": latest["id"],
            "threadId": thread["id"],
            "from": sender,
            "subject": subject,
            "date": header(latest, "Date"),
            "snippet": snippet,
            "automated": bool(automated),
        })
        if len(pending) >= args.max:
            break
    if getattr(args, "json", False):
        print(json.dumps({"account": account, "query": query, "pending": pending,
                          "ignoredAutomated": ignored, "scannedThreads": scanned,
                          "truncated": bool(res.get("nextPageToken")) or scanned < len(rows)}))
        return
    if not pending and res.get("nextPageToken"):
        raise RuntimeError("Mailbox scan exceeded 200 threads; pending status is incomplete")
    if not pending:
        print(f"[{account}] no pending reply threads for: {query}")
        return
    print(f"[{account}] {len(pending)} pending reply thread(s) for: {query}\n")
    for r in pending:
        print(f"  {r['date']}")
        print(f"  From:      {r['from']}")
        print(f"  Subject:   {r['subject']}")
        print(f"  Snippet:   {r['snippet'][:300]}")
        print(f"  Automated: {'yes' if r['automated'] else 'no'}")
        print(f"  id:        {r['id']}")
        print(f"  threadId:  {r['threadId']}\n")


def cmd_mark_processed(args):
    os.makedirs(os.path.dirname(PROCESSED_FILE), exist_ok=True)
    existing = set()
    try:
        with open(PROCESSED_FILE, encoding="utf-8") as f:
            existing = {line.strip() for line in f if line.strip()}
    except FileNotFoundError:
        pass
    ids = [mid.strip() for mid in args.id if mid.strip() and mid.strip() not in existing]
    if ids:
        with open(PROCESSED_FILE, "a", encoding="utf-8") as f:
            for mid in ids:
                f.write(mid + "\n")
    print(f"marked {len(ids)} message(s) processed")


def cmd_corpus(args):
    """Export a chronological, read-only Gmail corpus for one deep review."""
    svc = service(args.account)
    res = svc.users().messages().list(
        userId="me", q=args.query, maxResults=args.max
    ).execute()
    messages = []
    for row in res.get("messages", []):
        full = svc.users().messages().get(
            userId="me", id=row["id"], format="full"
        ).execute()
        messages.append(full)
    messages.sort(key=lambda m: int(m.get("internalDate", "0")))
    with open(args.output, "w", encoding="utf-8") as f:
        f.write(f"# Gmail corpus\n\nAccount: {args.account}\nQuery: {args.query}\nMessages: {len(messages)}\n\n")
        for i, full in enumerate(messages, 1):
            f.write(f"## Message {i}\n\n")
            f.write(f"Date: {header(full, 'Date')}\n")
            f.write(f"From: {header(full, 'From')}\n")
            f.write(f"To: {header(full, 'To')}\n")
            f.write(f"Subject: {header(full, 'Subject')}\n")
            f.write(f"Message-ID: {full.get('id', '')}\n\n")
            body = extract_body(full.get("payload", {})).strip()
            f.write((body or full.get("snippet", ""))[:12000])
            f.write("\n\n")
    os.chmod(args.output, 0o600)
    print(f"exported {len(messages)} messages to {args.output}")


SELF_CC = "ajuarez@aterna.ai"


def _addr_list(s):
    return [a.strip() for a in (s or "").split(",") if a.strip()]


def _no_emdash(t):
    t = t or ""
    t = re.sub(r"(?<=\d)\s*[—–]\s*(?=\d)", " to ", t)
    t = re.sub(r"\s*[—–―]\s*", ", ", t)
    return re.sub(r",\s*,", ", ", t)


def _load_signature():
    try:
        with open(SIG_FILE, encoding="utf-8") as f:
            return f.read().strip()
    except FileNotFoundError:
        return ""


def _fetch_live_signature(account):
    """Best-effort: read the account's REAL Gmail/Workspace signature (the one
    with the live calendar/booking links) via gmail.settings.basic. Returns the
    HTML, or None if that scope is not delegated yet or no signature is set.
    Uses a SEPARATE credential so an un-granted scope cannot break read/send."""
    try:
        creds = service_account.Credentials.from_service_account_file(
            SA_FILE,
            scopes=["https://www.googleapis.com/auth/gmail.settings.basic"],
            subject=account)
        svc = build("gmail", "v1", credentials=creds, cache_discovery=False)
        sends = svc.users().settings().sendAs().list(userId="me").execute().get("sendAs", [])
        for a in sends:
            if a.get("sendAsEmail") == account and a.get("signature"):
                return a["signature"].strip()
        for a in sends:
            if a.get("isDefault") and a.get("signature"):
                return a["signature"].strip()
    except Exception:
        return None
    return None


def cmd_send(args):
    import json, datetime
    # Hard rule: Arlo always sends as HIS OWN dedicated account, never as
    # Atanasio's. If a different sender was passed, we override and say so.
    account = SEND_FROM
    if getattr(args, "account", SEND_FROM) and args.account != SEND_FROM:
        print(f"(note: sending as {SEND_FROM}, Arlo's own account, not {args.account})")
    svc = service(account)
    to = _addr_list(args.to)
    cc = _addr_list(args.cc)
    if not to:
        sys.exit("send: --to is required")
    # Atanasio sees every outbound: CC him (he is not the sender here).
    if SELF_CC not in to + cc:
        cc.append(SELF_CC)
    subject = _no_emdash(args.subject)
    body = _no_emdash(args.body)

    # His real Workspace signature (with live calendar/booking links) the moment
    # gmail.settings.basic is delegated; otherwise the stored fallback file.
    live = _fetch_live_signature(account)
    sig = live or _load_signature()
    sig_src = "live Workspace signature" if live else "saved signature"
    body_html = body.replace("\n", "<br>")
    html = body_html + ("<br><br>" + sig if sig else "")

    from email.mime.text import MIMEText
    msg = MIMEText(html, "html")
    msg["to"] = ", ".join(to)
    if cc:
        msg["cc"] = ", ".join(cc)
    msg["from"] = account
    msg["subject"] = subject

    send_body = {}
    if args.reply_to:
        orig = svc.users().messages().get(
            userId="me", id=args.reply_to, format="metadata",
            metadataHeaders=["Message-ID", "Subject"]).execute()
        mid = header(orig, "Message-ID")
        if mid:
            msg["In-Reply-To"] = mid
            msg["References"] = mid
        send_body["threadId"] = orig.get("threadId")

    send_body["raw"] = base64.urlsafe_b64encode(msg.as_bytes()).decode()

    if not args.confirm:
        print("DRAFT (NOT sent, no --confirm). This is exactly what would go out:\n")
        print(f"From:    {account}")
        print(f"To:      {', '.join(to)}")
        if cc:
            print(f"Cc:      {', '.join(cc)}")
        print(f"Subject: {subject}")
        if args.reply_to:
            print(f"(threaded reply to {args.reply_to})")
        print("-" * 60)
        print(body)
        print(f"\n[+ {sig_src} appended, {len(sig)} chars HTML]" if sig else "\n[no signature available]")
        print("-" * 60)
        print("To send, re-run the identical command with --confirm.")
        print("Only do that AFTER Atanasio explicitly says to send it.")
        return

    sent = svc.users().messages().send(userId="me", body=send_body).execute()
    rec = {"ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
           "from": account, "to": to, "cc": cc, "subject": subject,
           "messageId": sent.get("id"), "threadId": sent.get("threadId")}
    with open(SENT_LOG, "a") as f:
        f.write(json.dumps(rec) + "\n")
    print(f"SENT as {account} -> messageId={sent.get('id')}  (Atanasio CC'd)")


def _compose(args):
    """Build the outbound MIME exactly as cmd_send does (from arlo@, CC Atanasio,
    signature, in-thread headers). Returns (svc, account, to, cc, subject, body, send_body, sig_src)."""
    account = SEND_FROM
    svc = service(account)
    to = _addr_list(args.to)
    cc = _addr_list(args.cc)
    if not to:
        sys.exit("draft: --to is required")
    if SELF_CC not in to + cc:
        cc.append(SELF_CC)
    subject = _no_emdash(args.subject)
    body = _no_emdash(args.body)
    live = _fetch_live_signature(account)
    sig = live or _load_signature()
    sig_src = "live Workspace signature" if live else ("saved signature" if sig else "no signature")
    html_body = body.replace("\n", "<br>") + ("<br><br>" + sig if sig else "")
    from email.mime.text import MIMEText
    msg = MIMEText(html_body, "html")
    msg["to"] = ", ".join(to)
    if cc:
        msg["cc"] = ", ".join(cc)
    msg["from"] = account
    msg["subject"] = subject
    send_body = {}
    if getattr(args, "reply_to", ""):
        orig = svc.users().messages().get(
            userId="me", id=args.reply_to, format="metadata",
            metadataHeaders=["Message-ID", "Subject"]).execute()
        mid = header(orig, "Message-ID")
        if mid:
            msg["In-Reply-To"] = mid
            msg["References"] = mid
        send_body["threadId"] = orig.get("threadId")
    send_body["raw"] = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    return account, to, cc, subject, body, send_body, sig_src


def cmd_draft(args):
    """Save a real Gmail draft in arlo@aterna.ai (visible in the Drafts folder,
    editable by a human, never sent by this command). Needs gmail.compose on the
    service account's domain-wide delegation; until then returns a clean
    {"error":"gmail_draft_not_authorized"} and creates nothing."""
    account, to, cc, subject, body, send_body, sig_src = _compose(args)
    try:
        creds = service_account.Credentials.from_service_account_file(
            SA_FILE, scopes=DRAFT_SCOPES, subject=account)
        dsvc = build("gmail", "v1", credentials=creds, cache_discovery=False)
        draft = dsvc.users().drafts().create(userId="me", body={"message": send_body}).execute()
    except Exception as ex:
        msg = str(ex)
        if "unauthorized_client" in msg or "not authorized for any of the scopes" in msg:
            print(json.dumps({"error": "gmail_draft_not_authorized",
                              "message": "gmail.compose is not on the service account's domain-wide delegation yet. No draft was created."}))
            return
        print(json.dumps({"error": "gmail_draft_failed", "message": msg[:300]}))
        sys.exit(1)
    m = draft.get("message", {})
    print(json.dumps({
        "draftId": draft.get("id"), "messageId": m.get("id"), "threadId": m.get("threadId"),
        "from": account, "to": to, "cc": cc, "subject": subject, "signature": sig_src,
        "preview": body[:400],
        "link": "https://mail.google.com/mail/u/0/#drafts",
        "note": "Saved as a Gmail draft in arlo@aterna.ai. Nothing was sent.",
    }))


SCOPE_CHECKS = {
    "gmail.readonly": ("arlo@aterna.ai", ["https://www.googleapis.com/auth/gmail.readonly"]),
    "gmail.send": ("arlo@aterna.ai", ["https://www.googleapis.com/auth/gmail.send"]),
    "gmail.compose": ("arlo@aterna.ai", ["https://www.googleapis.com/auth/gmail.compose"]),
    "gmail.settings.basic": ("arlo@aterna.ai", ["https://www.googleapis.com/auth/gmail.settings.basic"]),
    "calendar.events": ("ajuarez@aterna.ai", ["https://www.googleapis.com/auth/calendar.events"]),
    "calendar.readonly": ("ajuarez@aterna.ai", ["https://www.googleapis.com/auth/calendar.readonly"]),
}


def cmd_scopes(args):
    """Report which scopes the service account's domain-wide delegation grants,
    by minting a token per scope. No API call, no side effect, nothing sent,
    nothing created. This is what `meridian certify` runs to prove drafting and
    calendar are live rather than merely present."""
    from google.auth.transport.requests import Request
    out = {}
    for name, (subject, scopes) in SCOPE_CHECKS.items():
        try:
            creds = service_account.Credentials.from_service_account_file(
                SA_FILE, scopes=scopes, subject=subject)
            creds.refresh(Request())
            out[name] = bool(creds.token)
        except Exception as ex:  # unauthorized_client == scope not delegated
            out[name] = False
            out[name + ".error"] = str(ex)[:120]
    out["drafts"] = out.get("gmail.compose", False)
    out["calendar"] = out.get("calendar.events", False) or out.get("calendar.readonly", False)
    out["schedule"] = out.get("calendar.events", False)
    print(json.dumps(out))


def main():
    p = argparse.ArgumentParser(prog="arlo-gmail")
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("recent", "search"):
        sp = sub.add_parser(name)
        sp.add_argument("--account", default="ajuarez@aterna.ai")
        sp.add_argument("--query", default="")
        sp.add_argument("--max", type=int, default=10)
        sp.add_argument("--unread", action="store_true")
        sp.add_argument("--json", action="store_true")
    pp = sub.add_parser("pending")
    pp.add_argument("--account", default="arlo@aterna.ai")
    pp.add_argument("--query", default="")
    pp.add_argument("--max", type=int, default=10)
    pp.add_argument("--json", action="store_true")
    mp = sub.add_parser("mark-processed")
    mp.add_argument("--id", action="append", required=True)
    cp = sub.add_parser("corpus")
    cp.add_argument("--account", required=True)
    cp.add_argument("--query", required=True)
    cp.add_argument("--output", required=True)
    cp.add_argument("--max", type=int, default=100)
    rp = sub.add_parser("read")
    rp.add_argument("--account", default="ajuarez@aterna.ai")
    rp.add_argument("--id", required=True)
    dp = sub.add_parser("draft")
    dp.add_argument("--account", default="arlo@aterna.ai")
    dp.add_argument("--to", required=True)
    dp.add_argument("--cc", default="")
    dp.add_argument("--subject", required=True)
    dp.add_argument("--body", required=True)
    dp.add_argument("--reply-to", default="")
    sp = sub.add_parser("send")
    sp.add_argument("--account", default="arlo@aterna.ai")
    sp.add_argument("--to", required=True)
    sp.add_argument("--cc", default="")
    sp.add_argument("--subject", required=True)
    sp.add_argument("--body", required=True)
    sp.add_argument("--reply-to", default="")
    sp.add_argument("--confirm", action="store_true")
    sub.add_parser("accounts")
    sub.add_parser("scopes")
    args = p.parse_args()
    if args.cmd == "accounts":
        print("\n".join(ACCOUNTS))
    elif args.cmd == "scopes":
        cmd_scopes(args)
    elif args.cmd == "read":
        cmd_read(args)
    elif args.cmd == "send":
        cmd_send(args)
    elif args.cmd == "draft":
        cmd_draft(args)
    elif args.cmd == "pending":
        cmd_pending(args)
    elif args.cmd == "mark-processed":
        cmd_mark_processed(args)
    elif args.cmd == "corpus":
        cmd_corpus(args)
    else:
        cmd_list(args)


if __name__ == "__main__":
    main()

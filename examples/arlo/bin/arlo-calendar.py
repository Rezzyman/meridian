#!/root/.meridian/arlo/email-venv/bin/python
"""arlo-calendar — Google Calendar for Arlo via the ATERNA Google service
account (domain-wide delegation). Mirrors arlo-gmail.py. Read AND schedule.

Scopes (add to the service account's domain-wide delegation in Google Workspace
Admin -> Security -> API controls -> Domain-wide delegation -> the SA client id):
  https://www.googleapis.com/auth/calendar.events     (read + create events)
Reads also work with only https://www.googleapis.com/auth/calendar.readonly.
Until a scope is delegated, every call returns a clean
{"error":"calendar_not_authorized"} JSON and NO events. It never invents
appointments and never creates one when the scope is missing.

Usage:
  arlo-calendar today     [--account A]
  arlo-calendar upcoming  [--account A] [--days N]
  arlo-calendar schedule  --summary S --start ISO --end ISO [--attendees a,b] [--location L] [--description D] [--account A]

Times: --start/--end are ISO 8601; a naive time is taken as America/Denver
(override with TZ=). Output is JSON on one line, always.

GROUNDING: every event this prints is pulled live from Calendar this run.
"""
import argparse, datetime, json, os, sys

ARLO_HOME = os.environ.get("ARLO_HOME", "/root/.meridian/arlo")
SA = os.path.join(ARLO_HOME, "secrets/aterna-agents-sa.json")
SCOPES_RW = ["https://www.googleapis.com/auth/calendar.events"]
SCOPES_RO = ["https://www.googleapis.com/auth/calendar.readonly"]
DEFAULT_ACCOUNT = "ajuarez@aterna.ai"
LOCAL_TZ = os.environ.get("TZ") or "America/Denver"

NOT_AUTH = {"error": "calendar_not_authorized",
            "message": "Calendar scope not yet added to the service account's domain-wide delegation. No events; not inventing any."}


def _tz():
    from zoneinfo import ZoneInfo
    try:
        return ZoneInfo(LOCAL_TZ)
    except Exception:
        return ZoneInfo("America/Denver")


def _is_scope_error(ex):
    m = str(ex)
    return "unauthorized_client" in m or "not authorized for any of the scopes" in m or "invalid_scope" in m


def _service(account, scopes):
    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    creds = service_account.Credentials.from_service_account_file(SA, scopes=scopes).with_subject(account)
    return build("calendar", "v3", credentials=creds, cache_discovery=False)


def _shape(e):
    start = e.get("start", {}) or {}
    end = e.get("end", {}) or {}
    return {
        "id": e.get("id"),
        "summary": e.get("summary", "(no title)"),
        "start": start.get("dateTime") or start.get("date"),
        "end": end.get("dateTime") or end.get("date"),
        "location": e.get("location"),
        "attendees": [a.get("email") for a in (e.get("attendees") or []) if a.get("email")],
        "link": e.get("htmlLink"),
    }


def _list(account, time_min, time_max):
    """Read with the read+write scope first, then read-only, so whichever the
    admin delegated works. Raises the scope error only if both fail."""
    last = None
    for scopes in (SCOPES_RW, SCOPES_RO):
        try:
            svc = _service(account, scopes)
            ev = svc.events().list(
                calendarId="primary", timeMin=time_min, timeMax=time_max,
                maxResults=50, singleEvents=True, orderBy="startTime",
            ).execute()
            return [_shape(e) for e in ev.get("items", [])]
        except Exception as ex:
            last = ex
            if not _is_scope_error(ex):
                raise
    raise last


def _parse_when(s):
    """ISO 8601 in; aware datetime out. Naive input is local (America/Denver)."""
    d = datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
    if d.tzinfo is None:
        d = d.replace(tzinfo=_tz())
    return d


def cmd_schedule(a):
    start = _parse_when(a.start)
    end = _parse_when(a.end) if a.end else start + datetime.timedelta(minutes=30)
    if end <= start:
        print(json.dumps({"error": "calendar_bad_range", "message": "end must be after start"}))
        sys.exit(1)
    body = {
        "summary": a.summary.strip(),
        "start": {"dateTime": start.isoformat(), "timeZone": LOCAL_TZ},
        "end": {"dateTime": end.isoformat(), "timeZone": LOCAL_TZ},
    }
    if a.location:
        body["location"] = a.location
    if a.description:
        body["description"] = a.description
    attendees = [x.strip() for x in (a.attendees or "").split(",") if x.strip()]
    if attendees:
        body["attendees"] = [{"email": x} for x in attendees]
    try:
        svc = _service(a.account, SCOPES_RW)
        created = svc.events().insert(
            calendarId="primary", body=body, sendUpdates="all" if attendees else "none",
        ).execute()
    except Exception as ex:
        if _is_scope_error(ex):
            print(json.dumps({"error": "calendar_not_authorized",
                              "message": "calendar.events is not on the service account's domain-wide delegation yet. Nothing was scheduled."}))
            return
        print(json.dumps({"error": "calendar_write_failed", "message": str(ex)[:300]}))
        sys.exit(1)
    out = _shape(created)
    out.update({"account": a.account, "scheduled": True, "invitesSent": bool(attendees)})
    print(json.dumps(out))


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("today"); t.add_argument("--account", default=DEFAULT_ACCOUNT)
    u = sub.add_parser("upcoming"); u.add_argument("--account", default=DEFAULT_ACCOUNT); u.add_argument("--days", type=int, default=7)
    s = sub.add_parser("schedule")
    s.add_argument("--account", default=DEFAULT_ACCOUNT)
    s.add_argument("--summary", required=True)
    s.add_argument("--start", required=True)
    s.add_argument("--end", default="")
    s.add_argument("--attendees", default="")
    s.add_argument("--location", default="")
    s.add_argument("--description", default="")
    a = p.parse_args()
    if a.cmd == "schedule":
        cmd_schedule(a)
        return
    tz = _tz()
    now = datetime.datetime.now(tz)
    try:
        if a.cmd == "today":
            day = now.date()
            tmin = datetime.datetime.combine(day, datetime.time.min, tz).isoformat()
            tmax = datetime.datetime.combine(day, datetime.time.max, tz).isoformat()
            events = _list(a.account, tmin, tmax)
            print(json.dumps({"account": a.account, "date": str(day), "timezone": LOCAL_TZ, "count": len(events), "events": events}))
        else:
            days = max(1, min(a.days, 30))
            tmin = now.isoformat()
            tmax = (now + datetime.timedelta(days=days)).isoformat()
            events = _list(a.account, tmin, tmax)
            print(json.dumps({"account": a.account, "days": days, "timezone": LOCAL_TZ, "count": len(events), "events": events}))
    except Exception as ex:
        if _is_scope_error(ex):
            print(json.dumps(NOT_AUTH))
            sys.exit(0)
        print(json.dumps({"error": "calendar_read_failed", "message": str(ex)[:300]}))
        sys.exit(1)


if __name__ == "__main__":
    main()

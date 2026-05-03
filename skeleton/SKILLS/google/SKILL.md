---
name: google
description: Read and act on Gmail, Google Calendar, and Google Drive via the operator's authorized Google account
category: integrations
runtime: ts
trigger: operator asks me to check email, look at calendar, search inbox, schedule something, find a doc
sources: [Gmail API, Google Calendar API, Google Drive API]
output_format: structured per tool — message lists, event lists, doc lists with previews
---

I have direct read access (and limited write — drafts only by default) to
the operator's Gmail, Google Calendar, and Google Drive once they've
authorized the skill via OAuth.

## When to use

- "what's on my calendar today" → `gcal_today`
- "schedule X on Friday at 2pm" → `gcal_schedule` (drafts an event for review)
- "any new emails from Jeff" / "search inbox for 'Summit Prime'" → `gmail_search`
- "draft a reply to Mark Wilson" → `gmail_draft` (creates a draft only — never sends without explicit approval)
- "find that doc about Q3 plans" → `gdrive_search` then `gdrive_read`

## Auth

The OAuth flow runs once during `meridian skills setup google`. It
captures a refresh token + access token in the encrypted vault. Token
refreshes happen automatically on 401. If the operator revokes access
in Google account settings, the next call will fail cleanly and I tell
them to re-run setup.

## What I never do

- I never SEND email without explicit operator approval. Drafts only.
- I never DELETE calendar events or files without explicit operator approval.
- I never share Gmail/Calendar/Drive contents with anyone outside the operator's session.
- If the operator asks me to forward or share something to a third party, I show them the draft first and require an explicit "send it" before acting.

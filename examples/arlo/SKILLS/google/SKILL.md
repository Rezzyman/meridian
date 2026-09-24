---
name: google
description: Read, draft, and gated-send Gmail, plus read and schedule Google Calendar, through Arlo's Google service account. Every result is pulled live this run.
category: integrations
version: 0.2.0-sa
runtime: ts
trigger: operator asks me to check email, read the inbox, search mail, draft or send an email, look at the calendar, see what is coming up, or put something on the calendar
sources: [Gmail API (service account, domain-wide delegation), Google Calendar API (same service account)]
output_format: structured per tool. Message lists, message body, draft receipt, event lists, event receipt, or an explicit not-authorized error
---

I have LIVE access to Gmail and Calendar through the ATERNA service account
(ajuarez@aterna.ai by default; arlo@aterna.ai is my own mailbox and the only
sender). Every line these tools return was pulled from Google this run. I never
report email or calendar state I did not fetch this turn, and I never invent
messages, drafts, or appointments.

## Tools
- gmail_recent, gmail_search: find messages
- gmail_read, gmail_get: full body of one message by id
- gmail_pending: threads in arlo@ whose latest message is external and needs a reply
- gmail_draft: saves a REAL Gmail draft in arlo@ (Drafts folder), CC ajuarez@, signature appended, optional in-thread reply. Never sends. This is what "draft me an email" means.
- gmail_send: preview by default; sends only with confirm:true, always as arlo@, CC ajuarez@
- gcal_today, gcal_upcoming: events on the operator's primary calendar, Denver time
- gcal_schedule: creates an event; attendees get invites

## Hard rules
- Drafting is safe and expected. Sending needs the operator's explicit word in this conversation.
- Scheduling: confirm title, time, and attendees with the operator unless they gave all three explicitly.
- Outbound mail is ALWAYS from arlo@aterna.ai, never as Atanasio.
- If a tool returns { error }, I say plainly what I could not do and why. A not-authorized error means the Google admin has not delegated that scope yet; I say that, I do not work around it.

## Setup (once, by the Google Workspace admin)
Domain-wide delegation for the service account client id in the admin console
needs these scopes:
- https://www.googleapis.com/auth/gmail.readonly
- https://www.googleapis.com/auth/gmail.send
- https://www.googleapis.com/auth/gmail.compose (drafts)
- https://www.googleapis.com/auth/gmail.settings.basic (live signature, optional)
- https://www.googleapis.com/auth/calendar.events (calendar read + schedule)

---
name: calendar
description: Read and manage iCloud calendar events. Use for creating, updating, deleting, or listing events when the user asks about their calendar, schedule, or appointments.
allowed-tools: Bash(calendar:*)
---

# iCloud Calendar

Use the `calendar` command to interact with the user's iCloud calendar via CalDAV.

## List calendars

```bash
calendar list-calendars
```

Returns a JSON array of available calendars with `name`, `url`, and `color`.

## List events

```bash
# All upcoming events (no filter)
calendar list-events

# Events this week
calendar list-events --from 2026-03-23 --to 2026-03-29

# Events in a specific calendar
calendar list-events --calendar "Work" --from 2026-03-23 --to 2026-03-30
```

`--calendar` does a case-insensitive substring match. Omit `--from`/`--to` to get all events (may be slow on large calendars).

Each event in the response has: `uid`, `title`, `start`, `end`, `description`, `location`, `allDay`, `calendar`.

## Create an event

```bash
# Timed event
calendar create-event --title "Team standup" --start "2026-03-24T09:00:00" --end "2026-03-24T09:30:00"

# With calendar, description, and location
calendar create-event \
  --title "Dentist" \
  --start "2026-03-25T14:00:00" \
  --end "2026-03-25T15:00:00" \
  --calendar "Personal" \
  --description "Annual checkup" \
  --location "123 Main St"

# All-day event
calendar create-event --title "Conference" --start "2026-03-27" --end "2026-03-28" --all-day
```

- Dates must be ISO 8601. Use the user's local time (not UTC) unless they specify otherwise.
- If `--calendar` is omitted, the event goes to the default calendar (first non-birthday/holidays calendar).
- Returns `{ uid, calendar, url, status: "created" }` on success. Save the `uid` if the user may want to modify it.

## Update an event

Get the `uid` from `list-events` first, then:

```bash
calendar update-event --uid "A1B2C3D4-..." --title "Updated title" --start "2026-03-24T10:00:00"
```

Only the fields you pass are changed. Omit fields to keep them unchanged.

## Delete an event

```bash
calendar delete-event --uid "A1B2C3D4-..."

# Narrow search to a specific calendar (faster)
calendar delete-event --uid "A1B2C3D4-..." --calendar "Personal"
```

## Error handling

- **Auth error (401/403):** Tell the user to check that `CALDAV_USERNAME` and `CALDAV_PASSWORD` are set correctly in `.env`. The password must be an App-Specific Password from appleid.apple.com → Sign-In and Security → App-Specific Passwords — not the main Apple ID password.
- **Event not found:** Ask the user to confirm the UID using `list-events`.
- **Calendar not found:** Run `list-calendars` and show the user the available names.

## Tips

- When the user says "this week", compute the ISO date range from today's date.
- For recurring events, `list-events` returns individual instances — update/delete affects only that instance unless the user asks to change all occurrences.
- Prefer the user's named calendar when they specify one (e.g. "add to my work calendar").

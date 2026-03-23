---
name: calendar
description: Read and manage iCloud calendar events — list calendars, get events, create, update, or delete events. Use when the user asks about their schedule, wants to add a meeting, check upcoming events, or modify an existing event.
allowed-tools: mcp__icloud_calendar__list_calendars, mcp__icloud_calendar__get_events, mcp__icloud_calendar__create_event, mcp__icloud_calendar__update_event, mcp__icloud_calendar__delete_event
---

# iCloud Calendar

Calendar access is pre-configured. Use the `mcp__icloud_calendar__*` tools directly — no authentication needed.

## Available tools

### `mcp__icloud_calendar__list_calendars`
List all calendars in the iCloud account.
```
mcp__icloud_calendar__list_calendars()
```

### `mcp__icloud_calendar__get_events`
Fetch events within a date range.
```
mcp__icloud_calendar__get_events({
  startDate: "2026-03-22T00:00:00",  // ISO 8601
  endDate:   "2026-03-29T23:59:59",
  calendarId: "optional-calendar-id" // omit to search all calendars
})
```

### `mcp__icloud_calendar__create_event`
Create a new calendar event.
```
mcp__icloud_calendar__create_event({
  title:       "Team standup",
  startDate:   "2026-03-23T09:00:00",
  endDate:     "2026-03-23T09:30:00",
  calendarId:  "optional-calendar-id",  // uses default if omitted
  description: "optional notes",
  location:    "optional location"
})
```

### `mcp__icloud_calendar__update_event`
Update an existing event by its ID.
```
mcp__icloud_calendar__update_event({
  eventId:   "event-id-from-get_events",
  title:     "Updated title",
  startDate: "2026-03-23T10:00:00",
  endDate:   "2026-03-23T10:30:00"
})
```

### `mcp__icloud_calendar__delete_event`
Delete an event by its ID.
```
mcp__icloud_calendar__delete_event({
  eventId: "event-id-from-get_events"
})
```

## Workflow tips

- If the user doesn't specify a calendar, use `list_calendars` first to find the right one, or omit `calendarId` to use the default.
- Always confirm event details (title, time, date) before creating — ask if anything is ambiguous.
- Use the user's local timezone when interpreting times. The current date is available in your context.

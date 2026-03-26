#!/usr/bin/env node
/**
 * iCloud CalDAV helper for NanoClaw agent containers.
 * Zero external dependencies — uses Node 22 built-in fetch, crypto, Buffer.
 *
 * Usage:
 *   calendar list-calendars
 *   calendar list-events [--calendar NAME] [--from ISO_DATE] [--to ISO_DATE]
 *   calendar create-event --title STR --start ISO_DATETIME --end ISO_DATETIME
 *                         [--calendar NAME] [--description STR] [--location STR] [--all-day]
 *                         [--alert OFFSET]  (e.g. --alert 15m --alert 1h --alert 1d)
 *   calendar update-event --uid UID [--title STR] [--start ISO_DATETIME]
 *                         [--end ISO_DATETIME] [--description STR] [--location STR]
 *                         [--alert OFFSET]  (replaces existing alarms; omit to preserve them)
 *   calendar delete-event --uid UID [--calendar NAME]
 *
 * Credentials via OneCLI proxy — Authorization header injected automatically.
 */

import { randomUUID } from 'crypto';

const USERNAME = process.env.CALDAV_USERNAME;
const PASSWORD = process.env.CALDAV_PASSWORD;

if (!USERNAME || !PASSWORD) {
  console.error('Error: CALDAV_USERNAME and CALDAV_PASSWORD must be set in .env');
  process.exit(1);
}

const AUTH = 'Basic ' + Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
const CALDAV_BASE = 'https://caldav.icloud.com';

// ── XML helpers ────────────────────────────────────────────────────────────

function xmlTag(tag, text) {
  const localTag = tag.includes(':') ? tag : tag;
  const re = new RegExp(`<${localTag}[^>]*>([\\s\\S]*?)<\/${localTag}>`, 'i');
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

function xmlAttr(tag, attr, text) {
  const re = new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`, 'i');
  const m = text.match(re);
  return m ? m[1] : null;
}

function allMatches(re, text) {
  const results = [];
  let m;
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  while ((m = r.exec(text)) !== null) results.push(m);
  return results;
}

// Match a tag with optional namespace prefix (e.g. D:href or just href)
function tagRe(localName) {
  return new RegExp(`<(?:[a-zA-Z]+:)?${localName}[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z]+:)?${localName}>`, 'i');
}

function extractHref(block) {
  const m = block.match(tagRe('href'));
  return m ? m[1].trim() : null;
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

async function caldavRequest(method, url, body, extraHeaders = {}) {
  const fullUrl = url.startsWith('http') ? url : CALDAV_BASE + url;
  const headers = {
    Authorization: AUTH,
    'Content-Type': 'text/xml; charset=utf-8',
    ...extraHeaders,
  };
  if (body) headers['Content-Length'] = Buffer.byteLength(body).toString();

  const res = await fetch(fullUrl, {
    method,
    headers,
    body: body || undefined,
    redirect: 'follow',
  });

  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text, url: res.url };
}

// ── CalDAV discovery ───────────────────────────────────────────────────────

async function discoverCalendarHome() {
  // Step 1: find current-user-principal
  const propfind1 = `<?xml version="1.0" encoding="UTF-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:current-user-principal/>
  </D:prop>
</D:propfind>`;

  const r1 = await caldavRequest('PROPFIND', '/', propfind1, { Depth: '0' });
  if (r1.status >= 400) {
    throw new Error(`Authentication failed (${r1.status}). Check CALDAV_USERNAME and CALDAV_PASSWORD in .env`);
  }

  // Extract principal href — handle both D:href and bare href (iCloud default namespace)
  let principalHref = null;
  const principalBlock = r1.body.match(/<(?:[a-zA-Z]+:)?current-user-principal[^>]*>([\s\S]*?)<\/(?:[a-zA-Z]+:)?current-user-principal>/i);
  if (principalBlock) {
    const m = principalBlock[1].match(tagRe('href'));
    if (m) principalHref = m[1].trim();
  }

  if (!principalHref) {
    // iCloud sometimes redirects directly to the user's home
    principalHref = new URL(r1.url).pathname;
  }

  // Step 2: find calendar-home-set from principal
  const propfind2 = `<?xml version="1.0" encoding="UTF-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <C:calendar-home-set/>
  </D:prop>
</D:propfind>`;

  const principalUrl = principalHref.startsWith('http') ? principalHref : CALDAV_BASE + principalHref;
  const r2 = await caldavRequest('PROPFIND', principalUrl, propfind2, { Depth: '0' });

  let homeHref = null;
  const homeBlock = r2.body.match(/<(?:[a-zA-Z]+:)?calendar-home-set[^>]*>([\s\S]*?)<\/(?:[a-zA-Z]+:)?calendar-home-set>/i);
  if (homeBlock) {
    const m = homeBlock[1].match(tagRe('href'));
    if (m) homeHref = m[1].trim();
  }

  if (!homeHref) {
    // Fall back to principal URL itself as calendar home
    homeHref = principalHref;
  }

  return homeHref.startsWith('http') ? homeHref : CALDAV_BASE + homeHref;
}

async function listCalendars(calendarHome) {
  const propfind = `<?xml version="1.0" encoding="UTF-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="http://apple.com/ns/ical/">
  <D:prop>
    <D:displayname/>
    <D:resourcetype/>
    <A:calendar-color/>
    <C:calendar-description/>
    <C:supported-calendar-component-set/>
  </D:prop>
</D:propfind>`;

  const r = await caldavRequest('PROPFIND', calendarHome, propfind, { Depth: '1' });

  const calendars = [];
  // Split on response elements (handle both D:response and bare response)
  const responseBlocks = allMatches(/<(?:[a-zA-Z]+:)?response[^>]*>([\s\S]*?)<\/(?:[a-zA-Z]+:)?response>/i, r.body);

  for (const [, block] of responseBlocks) {
    // Must be a calendar collection — check resourcetype contains "calendar"
    const resourceType = block.match(/<(?:[a-zA-Z]+:)?resourcetype[^>]*>([\s\S]*?)<\/(?:[a-zA-Z]+:)?resourcetype>/i)?.[1] || '';
    if (!resourceType.match(/<(?:[a-zA-Z]+:)?calendar[\s/>]/i)) continue;

    const href = extractHref(block);
    const name = block.match(/<(?:[a-zA-Z]+:)?displayname[^>]*>([\s\S]*?)<\/(?:[a-zA-Z]+:)?displayname>/i)?.[1]?.trim();
    const color = block.match(/<(?:[a-zA-Z]+:)?calendar-color[^>]*>([\s\S]*?)<\/(?:[a-zA-Z]+:)?calendar-color>/i)?.[1]?.trim();

    if (href && name) {
      const url = href.startsWith('http') ? href : CALDAV_BASE + href;
      calendars.push({ name, url, color: color || null });
    }
  }

  return calendars;
}

// ── Event helpers ──────────────────────────────────────────────────────────

function parseIcalDate(str) {
  if (!str) return null;
  str = str.replace(/^VALUE=DATE:/, '').replace(/^TZID=[^:]+:/, '');
  // DATE-TIME: 20240115T143000Z or 20240115T143000
  // DATE: 20240115
  if (str.includes('T')) {
    const d = str.replace('Z', '');
    return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}:${d.slice(13, 15)}${str.endsWith('Z') ? 'Z' : ''}`;
  } else {
    return `${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}`;
  }
}

function icalProp(ical, prop) {
  const re = new RegExp(`^${prop}[;:]([^\\r\\n]*)`, 'm');
  const m = ical.match(re);
  return m ? m[1].trim() : null;
}

function parseEvent(ical, url) {
  const vevents = allMatches(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/i, ical);
  const results = [];
  for (const [, body] of vevents) {
    const unfold = body.replace(/\r?\n[ \t]/g, '');

    // Extract VALARM sub-components
    const alarms = [];
    const valarmRe = /BEGIN:VALARM([\s\S]*?)END:VALARM/gi;
    let vm;
    while ((vm = valarmRe.exec(unfold)) !== null) {
      const vb = vm[1];
      const trigger = (vb.match(/^TRIGGER[^:]*:(.+)$/m) || [])[1]?.trim();
      const action  = (vb.match(/^ACTION:(.+)$/m) || [])[1]?.trim();
      const desc    = (vb.match(/^DESCRIPTION:(.+)$/m) || [])[1]?.trim();
      if (trigger) alarms.push({ trigger, action: action || 'DISPLAY', ...(desc ? { description: desc } : {}) });
    }

    const event = {
      uid: icalProp(unfold, 'UID'),
      title: icalProp(unfold, 'SUMMARY'),
      start: parseIcalDate(icalProp(unfold, 'DTSTART')),
      end: parseIcalDate(icalProp(unfold, 'DTEND')),
      description: icalProp(unfold, 'DESCRIPTION'),
      location: icalProp(unfold, 'LOCATION'),
      allDay: !icalProp(unfold, 'DTSTART')?.includes('T'),
      url,
    };
    if (alarms.length) event.alarms = alarms;
    results.push(event);
  }
  return results;
}

function toIcalDateTime(iso) {
  // Convert ISO 8601 to iCal format
  if (!iso) return null;
  if (iso.includes('T')) {
    const clean = iso.replace(/[-:]/g, '').replace('.000', '');
    // Keep Z suffix if present
    return clean.endsWith('Z') ? clean : clean + (clean.includes('T') ? '' : '');
  } else {
    return iso.replace(/-/g, '');
  }
}

function parseAlertOffset(str) {
  const m = str.trim().match(/^(\d+)\s*(m|min|minutes?|h|hr|hours?|d|days?)$/i);
  if (!m) throw new Error(`Invalid alert offset "${str}". Use formats like "15m", "1h", "2h", "1d".`);
  const n = parseInt(m[1], 10);
  const unit = m[2][0].toLowerCase();
  if (unit === 'm') return `-PT${n}M`;
  if (unit === 'h') return `-PT${n}H`;
  if (unit === 'd') return `-P${n}D`;
  throw new Error(`Unrecognized unit in "${str}"`);
}

function buildIcal({ uid, title, start, end, description, location, allDay, created }, alarms = []) {
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const dtStamp = now.endsWith('Z') ? now : now + 'Z';
  const createdAt = created || dtStamp;

  let lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//NanoClaw//CalDAV//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtStamp}`,
    `CREATED:${createdAt}`,
    `LAST-MODIFIED:${dtStamp}`,
  ];

  if (allDay) {
    lines.push(`DTSTART;VALUE=DATE:${toIcalDateTime(start)}`);
    if (end) lines.push(`DTEND;VALUE=DATE:${toIcalDateTime(end)}`);
  } else {
    lines.push(`DTSTART:${toIcalDateTime(start)}`);
    if (end) lines.push(`DTEND:${toIcalDateTime(end)}`);
  }

  lines.push(`SUMMARY:${title}`);
  if (description) lines.push(`DESCRIPTION:${description.replace(/\n/g, '\\n')}`);
  if (location) lines.push(`LOCATION:${location}`);
  for (const alarm of alarms) {
    lines.push('BEGIN:VALARM');
    lines.push(`ACTION:${alarm.action || 'DISPLAY'}`);
    lines.push(`TRIGGER:${alarm.trigger}`);
    if (alarm.description) lines.push(`DESCRIPTION:${alarm.description}`);
    lines.push('END:VALARM');
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');

  return lines.join('\r\n') + '\r\n';
}

// ── Commands ───────────────────────────────────────────────────────────────

async function cmdListCalendars() {
  const home = await discoverCalendarHome();
  const cals = await listCalendars(home);
  console.log(JSON.stringify(cals, null, 2));
}

async function cmdListEvents(args) {
  const calendarName = args['--calendar'] || null;
  const from = args['--from'] ? new Date(args['--from']) : null;
  const to = args['--to'] ? new Date(args['--to']) : null;

  const home = await discoverCalendarHome();
  const cals = await listCalendars(home);

  const targetCals = calendarName
    ? cals.filter(c => c.name.toLowerCase().includes(calendarName.toLowerCase()))
    : cals;

  if (targetCals.length === 0) {
    throw new Error(`No calendar found matching "${calendarName}". Available: ${cals.map(c => c.name).join(', ')}`);
  }

  const events = [];
  for (const cal of targetCals) {
    let reportBody = `<?xml version="1.0" encoding="UTF-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">`;

    if (from || to) {
      const startStr = from ? from.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z/, 'Z') : '19000101T000000Z';
      const endStr = to ? to.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z/, 'Z') : '29991231T235959Z';
      reportBody += `\n        <C:time-range start="${startStr}" end="${endStr}"/>`;
    }

    reportBody += `
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;

    const r = await caldavRequest('REPORT', cal.url, reportBody, {
      Depth: '1',
      'Content-Type': 'text/xml; charset=utf-8',
    });

    const responseBlocks = allMatches(/<(?:[a-zA-Z]+:)?response[^>]*>([\s\S]*?)<\/(?:[a-zA-Z]+:)?response>/i, r.body);
    for (const [, block] of responseBlocks) {
      const href = extractHref(block);
      const calData = block.match(/<(?:[a-zA-Z]+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:[a-zA-Z]+:)?calendar-data>/i)?.[1];
      if (calData) {
        const url = href ? (href.startsWith('http') ? href : CALDAV_BASE + href) : cal.url;
        const parsed = parseEvent(calData, url);
        for (const ev of parsed) {
          events.push({ ...ev, calendar: cal.name });
        }
      }
    }
  }

  // Sort by start time
  events.sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  console.log(JSON.stringify(events, null, 2));
}

async function cmdCreateEvent(args) {
  const title = args['--title'];
  const start = args['--start'];
  const end = args['--end'];
  if (!title || !start) throw new Error('--title and --start are required');

  const calendarName = args['--calendar'] || null;
  const home = await discoverCalendarHome();
  const cals = await listCalendars(home);

  let cal;
  if (calendarName) {
    cal = cals.find(c => c.name.toLowerCase().includes(calendarName.toLowerCase()));
    if (!cal) throw new Error(`Calendar not found: "${calendarName}". Available: ${cals.map(c => c.name).join(', ')}`);
  } else {
    // Prefer a calendar named exactly "Calendar", then any non-task/birthday/holiday calendar
    cal = cals.find(c => /^calendar$/i.test(c.name))
      || cals.find(c => !/(birthday|holidays|to.?do|tasks|reminders)/i.test(c.name))
      || cals[0];
  }

  const uid = randomUUID().toUpperCase();
  const alertRaw = args['--alert'] !== undefined ? [].concat(args['--alert']) : [];
  const alarms = alertRaw.map(a => ({ trigger: parseAlertOffset(a), action: 'DISPLAY' }));
  const ical = buildIcal({
    uid,
    title,
    start,
    end: end || start,
    description: args['--description'] || null,
    location: args['--location'] || null,
    allDay: !!args['--all-day'],
  }, alarms);

  const eventUrl = cal.url + uid + '.ics';
  const r = await caldavRequest('PUT', eventUrl, ical, {
    'Content-Type': 'text/calendar; charset=utf-8',
    'If-None-Match': '*',
  });

  if (r.status >= 400) {
    throw new Error(`Failed to create event (${r.status}): ${r.body.slice(0, 200)}`);
  }

  console.log(JSON.stringify({ uid, calendar: cal.name, url: eventUrl, status: 'created' }));
}

async function cmdUpdateEvent(args) {
  const uid = args['--uid'];
  if (!uid) throw new Error('--uid is required');

  const calendarName = args['--calendar'] || null;
  const home = await discoverCalendarHome();
  const cals = await listCalendars(home);

  const targetCals = calendarName
    ? cals.filter(c => c.name.toLowerCase().includes(calendarName.toLowerCase()))
    : cals;

  // Find the event across calendars
  let eventUrl = null;
  let existingIcal = null;

  for (const cal of targetCals) {
    const testUrl = cal.url + uid + '.ics';
    const r = await caldavRequest('GET', testUrl, null, {});
    if (r.status === 200) {
      eventUrl = testUrl;
      existingIcal = r.body;
      break;
    }
  }

  if (!eventUrl) {
    throw new Error(`Event with UID "${uid}" not found. Use list-events to get UIDs.`);
  }

  // Parse existing event
  const existing = parseEvent(existingIcal, eventUrl)[0];
  if (!existing) throw new Error('Could not parse existing event');

  let alarms;
  if (args['--alert'] !== undefined) {
    alarms = [].concat(args['--alert']).map(a => ({ trigger: parseAlertOffset(a), action: 'DISPLAY' }));
  } else {
    alarms = existing.alarms || [];
  }

  const updated = buildIcal({
    uid,
    title: args['--title'] || existing.title,
    start: args['--start'] || existing.start,
    end: args['--end'] || existing.end,
    description: args['--description'] !== undefined ? args['--description'] : existing.description,
    location: args['--location'] !== undefined ? args['--location'] : existing.location,
    allDay: existing.allDay,
  }, alarms);

  const r = await caldavRequest('PUT', eventUrl, updated, {
    'Content-Type': 'text/calendar; charset=utf-8',
  });

  if (r.status >= 400) {
    throw new Error(`Failed to update event (${r.status}): ${r.body.slice(0, 200)}`);
  }

  console.log(JSON.stringify({ uid, url: eventUrl, status: 'updated' }));
}

async function cmdDeleteEvent(args) {
  const uid = args['--uid'];
  if (!uid) throw new Error('--uid is required');

  const calendarName = args['--calendar'] || null;
  const home = await discoverCalendarHome();
  const cals = await listCalendars(home);

  const targetCals = calendarName
    ? cals.filter(c => c.name.toLowerCase().includes(calendarName.toLowerCase()))
    : cals;

  let deleted = false;
  for (const cal of targetCals) {
    const testUrl = cal.url + uid + '.ics';
    const check = await caldavRequest('GET', testUrl, null, {});
    if (check.status === 200) {
      const r = await caldavRequest('DELETE', testUrl, null, {});
      if (r.status >= 400) {
        throw new Error(`Failed to delete event (${r.status})`);
      }
      console.log(JSON.stringify({ uid, url: testUrl, status: 'deleted' }));
      deleted = true;
      break;
    }
  }

  if (!deleted) {
    throw new Error(`Event with UID "${uid}" not found.`);
  }
}

// ── CLI argument parser ────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        if (token in args) {
          // Repeated flag → accumulate as array
          args[token] = [].concat(args[token], next);
        } else {
          args[token] = next;
        }
        i += 2;
      } else {
        args[token] = true;
        i += 1;
      }
    } else {
      i += 1;
    }
  }
  return args;
}

// ── Main ───────────────────────────────────────────────────────────────────

const [, , command, ...rest] = process.argv;
const args = parseArgs(rest);

const commands = {
  'list-calendars': cmdListCalendars,
  'list-events': cmdListEvents,
  'create-event': cmdCreateEvent,
  'update-event': cmdUpdateEvent,
  'delete-event': cmdDeleteEvent,
};

if (!command || !commands[command]) {
  console.error(`Usage: calendar <command> [options]`);
  console.error(`Commands: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}

commands[command](args).catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});

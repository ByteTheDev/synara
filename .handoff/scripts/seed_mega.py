# Clone real threads into long synthetic threads (projection tables only) for benchmarks.
import sqlite3, sys, datetime
db = sys.argv[1]
con = sqlite3.connect(db)
con.row_factory = sqlite3.Row

def shift(ts, delta):
    if ts is None: return None
    d = datetime.datetime.strptime(ts.replace('Z', '+0000'), '%Y-%m-%dT%H:%M:%S.%f%z')
    return (d + delta).strftime('%Y-%m-%dT%H:%M:%S.') + f"{(d + delta).microsecond // 1000:03d}Z"

def clone(src, dst, title, copies):
    cur = con.cursor()
    span = cur.execute("select min(created_at) a, max(created_at) b from (select created_at from projection_thread_messages where thread_id=? union all select created_at from projection_thread_activities where thread_id=?)", (src, src)).fetchone()
    fmt = lambda t: datetime.datetime.strptime(t.replace('Z', '+0000'), '%Y-%m-%dT%H:%M:%S.%f%z')
    width = fmt(span['b']) - fmt(span['a']) + datetime.timedelta(hours=1)
    sfx = lambda v, n: None if v is None else f"{v}-c{n}"
    for table in ("projection_thread_messages", "projection_thread_activities", "projection_turns", "projection_thread_sessions"):
        cur.execute(f"delete from {table} where thread_id=?", (dst,))
    cur.execute("delete from projection_threads where thread_id=?", (dst,))
    for n in range(copies):
        delta = width * n
        for r in cur.execute("select * from projection_thread_messages where thread_id=?", (src,)).fetchall():
            d = dict(r)
            d.update(message_id=sfx(d['message_id'], n), thread_id=dst, turn_id=sfx(d['turn_id'], n),
                     created_at=shift(d['created_at'], delta), updated_at=shift(d['updated_at'], delta), sequence=None)
            con.execute(f"insert into projection_thread_messages ({','.join(d)}) values ({','.join('?'*len(d))})", list(d.values()))
        for r in cur.execute("select * from projection_thread_activities where thread_id=?", (src,)).fetchall():
            d = dict(r)
            d.update(activity_id=sfx(d['activity_id'], n), thread_id=dst, turn_id=sfx(d['turn_id'], n),
                     created_at=shift(d['created_at'], delta), sequence=None)
            con.execute(f"insert into projection_thread_activities ({','.join(d)}) values ({','.join('?'*len(d))})", list(d.values()))
        for r in cur.execute("select * from projection_turns where thread_id=?", (src,)).fetchall():
            d = dict(r); d.pop('row_id')
            d.update(thread_id=dst, turn_id=sfx(d['turn_id'], n), pending_message_id=sfx(d['pending_message_id'], n),
                     assistant_message_id=sfx(d['assistant_message_id'], n),
                     requested_at=shift(d['requested_at'], delta), started_at=shift(d['started_at'], delta),
                     completed_at=shift(d['completed_at'], delta),
                     checkpoint_turn_count=None if d['checkpoint_turn_count'] is None else d['checkpoint_turn_count'] + n * 1000)
            con.execute(f"insert into projection_turns ({','.join(d)}) values ({','.join('?'*len(d))})", list(d.values()))
    t = dict(cur.execute("select * from projection_threads where thread_id=?", (src,)).fetchone())
    last = copies - 1
    t.update(thread_id=dst, title=title, archived_at=None, latest_turn_id=sfx(t['latest_turn_id'], last),
             updated_at=shift(t['updated_at'], width * last), is_pinned=1, parent_thread_id=None)
    con.execute(f"insert into projection_threads ({','.join(t)}) values ({','.join('?'*len(t))})", list(t.values()))
    s = cur.execute("select * from projection_thread_sessions where thread_id=?", (src,)).fetchone()
    if s:
        d = dict(s); d['thread_id'] = dst
        if 'active_turn_id' in d: d['active_turn_id'] = None
        con.execute(f"insert into projection_thread_sessions ({','.join(d)}) values ({','.join('?'*len(d))})", list(d.values()))

clone('730ef11a-0b9f-4b21-a84f-5e2e92919823', 'perf0000-mega-tool-0000-000000000001', 'PERF mega tools (6x)', 6)
clone('642193dd-0ebb-4877-9fdd-ac2ccdbf3f4f', 'perf0000-long-chat-0000-000000000002', 'PERF long chat (20x)', 20)
con.commit()
for tid in ('perf0000-mega-tool-0000-000000000001', 'perf0000-long-chat-0000-000000000002'):
    print(tid, con.execute("select count(*) from projection_thread_messages where thread_id=?", (tid,)).fetchone()[0],
          con.execute("select count(*) from projection_thread_activities where thread_id=?", (tid,)).fetchone()[0])

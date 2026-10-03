import pg from 'pg';

// DATE columns are calendar dates, not instants: keep them as 'YYYY-MM-DD'
// strings so no time-zone conversion can shift the day.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

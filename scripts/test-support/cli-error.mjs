export function cliError(stderr) {
  const sqliteWarning = /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?\n(?:\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n)?/gm;
  return JSON.parse(stderr.replace(sqliteWarning, '').trim());
}

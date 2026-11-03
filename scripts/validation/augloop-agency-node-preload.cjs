'use strict';

delete process.env.LAGE_GIT_IGNORED_FILES;

if (process.env.AGENCY_AL_PRELOAD_AUDIT) {
  const { appendFileSync } = require('node:fs');
  appendFileSync(process.env.AGENCY_AL_PRELOAD_AUDIT, `${JSON.stringify({
    pid: process.pid,
    parentPid: process.ppid,
    observedAt: new Date().toISOString(),
    lageGitIgnoredFilesPresent: Object.hasOwn(process.env, 'LAGE_GIT_IGNORED_FILES')
  })}\n`);
}

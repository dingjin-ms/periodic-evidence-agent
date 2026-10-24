// Only structured, non-payload transport diagnostics cross reporting boundaries.
export function failureDetails(value) {
  const result = {};
  if (Number.isInteger(value?.statusCode) && value.statusCode >= 100 && value.statusCode <= 599)
    result.statusCode = value.statusCode;
  if (Number.isSafeInteger(value?.retryAfterSeconds) && value.retryAfterSeconds >= 0)
    result.retryAfterSeconds = value.retryAfterSeconds;
  for (const key of ['errorCode', 'recoveryAction'])
    if (typeof value?.[key] === 'string' && /^[\w.-]{1,128}$/.test(value[key])) result[key] = value[key];
  return result;
}

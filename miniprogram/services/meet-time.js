/** 校内运动会的无时区输入统一按北京时间解释，避免云函数 UTC 与手机相差八小时。 */
function parseMeetTime(value) {
  if (value instanceof Date) return value.getTime();
  const text = String(value || '').trim().replace(' ', 'T');
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/.exec(text);
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] || 0) > 59) return NaN;
  const day = Date.parse(`${match[1]}T00:00:00Z`);
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== match[1]) return NaN;
  return Date.parse(match[5] ? text : `${text}+08:00`);
}

module.exports = { parseMeetTime };

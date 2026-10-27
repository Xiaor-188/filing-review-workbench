export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export function fail(status, code, message) { throw new ApiError(status, code, message); }
export function exactFields(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_object', '请求必须是 JSON 对象。');
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(400, 'unknown_fields', '请求包含不支持的字段；不能提交状态、校验或确认结果。');
  if (required.some(key => !(key in value))) fail(400, 'missing_fields', `缺少必需字段：${required.filter(key => !(key in value)).join('、')}`);
}
export function boundedString(value, label, { max = 1000, empty = false } = {}) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /\u0000/.test(value)) fail(400, 'invalid_string', `${label}须为${empty ? '可为空的' : '非空'}文本，长度不超过 ${max}。`);
  return value.trim();
}

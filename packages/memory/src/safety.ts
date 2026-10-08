import { DomainError } from '@aiappnest/domain';
export function validateContent(content:string) {
  if (/(?:sk-[a-z0-9_-]{8,}|(?:api[_ -]?key|password|passwd|secret|token|密码|密钥)\s*["']?\s*[:=：]\s*\S+|bearer\s+[a-z0-9._-]{8,}|-----BEGIN [\w ]*PRIVATE KEY-----|AKIA[A-Z0-9]{16}|gh[pousr]_[a-z0-9]{16,})/i.test(content.normalize('NFKC'))) throw new DomainError('INVALID_INPUT');
}

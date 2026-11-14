export function getApiPrefix(): string {
  if (typeof window !== 'undefined' && window.location.pathname.startsWith('/godsear')) {
    return '/api/godsear';
  }
  return '/api';
}

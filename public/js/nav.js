// A view can block leaving it (e.g. while recording) by setting a guard that
// returns false to stay.
let guard = null;

export function setNavGuard(fn) {
  guard = fn;
}

export function checkNavGuard() {
  if (!guard) return true;
  const ok = guard();
  if (ok) guard = null;
  return ok;
}

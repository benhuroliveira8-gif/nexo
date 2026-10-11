// Arrastar e soltar para reordenar (funciona com mouse e com o dedo).
// No mouse: clique e arraste. No celular: segure o item por meio segundo e arraste.
//
// sortable(container, {
//   handle: '.item',                         // elementos que podem ser arrastados (com data-drag-id)
//   targets: '.item, .header',               // onde dá para soltar
//   canDrop: (dragEl, targetEl, before) => true/false,
//   onDrop: (dragEl, targetEl, before) => {},
// })
const LONG_PRESS_MS = 450;
const MOVE_TOLERANCE = 8;

export function sortable(container, opts) {
  if (container._sortable) container._sortable.opts = opts;
  if (container._sortable) return;
  const st = { opts };
  container._sortable = st;

  let pending = null; // { el, x, y, pointerId, timer, touch }
  let drag = null;    // { el, ghost, line, offsetY, target, before }

  const cleanupPending = () => {
    if (pending && pending.timer) clearTimeout(pending.timer);
    pending = null;
  };

  container.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const el = e.target.closest(st.opts.handle);
    if (!el || !container.contains(el) || !el.dataset.dragId) return;
    if (e.target.closest('input, textarea, .no-drag')) return;
    cleanupPending();
    pending = { el, x: e.clientX, y: e.clientY, pointerId: e.pointerId, touch: e.pointerType !== 'mouse' };
    if (pending.touch) {
      pending.timer = setTimeout(() => {
        if (!pending) return;
        if (navigator.vibrate) { try { navigator.vibrate(15); } catch { /* sem vibração */ } }
        start(pending.el, pending.x, pending.y);
      }, LONG_PRESS_MS);
    }
  });

  window.addEventListener('pointermove', (e) => {
    if (drag) { move(e.clientX, e.clientY); return; }
    if (!pending || e.pointerId !== pending.pointerId) return;
    const dist = Math.hypot(e.clientX - pending.x, e.clientY - pending.y);
    if (pending.touch) {
      if (dist > MOVE_TOLERANCE) cleanupPending(); // a pessoa está rolando a lista
    } else if (dist > 6) {
      start(pending.el, e.clientX, e.clientY);
    }
  });

  // Enquanto arrasta com o dedo, a página não rola.
  document.addEventListener('touchmove', (e) => { if (drag) e.preventDefault(); }, { passive: false });
  // Segurar o dedo não abre o menu do navegador.
  container.addEventListener('contextmenu', (e) => { if (pending || drag) e.preventDefault(); });

  const finish = (e) => {
    cleanupPending();
    if (!drag) return;
    const d = drag;
    drag = null;
    d.ghost.remove();
    d.line.remove();
    d.el.classList.remove('dragging');
    document.body.classList.remove('is-dragging');
    clearInterval(d.scrollTimer);
    // O clique que vem logo depois de soltar não deve abrir o item.
    const stop = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
    window.addEventListener('click', stop, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 50);
    if (e && e.type === 'pointerup' && d.target && st.opts.onDrop) st.opts.onDrop(d.el, d.target, d.before);
  };
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', (e) => { if (!drag) cleanupPending(); else finish(e); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drag) finish(null); });

  function start(el, x, y) {
    cleanupPending();
    const r = el.getBoundingClientRect();
    const ghost = el.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.removeAttribute('id');
    Object.assign(ghost.style, { width: `${r.width}px`, left: `${r.left}px`, top: `${r.top}px` });
    document.body.append(ghost);
    const line = document.createElement('div');
    line.className = 'drop-line';
    line.hidden = true;
    document.body.append(line);
    el.classList.add('dragging');
    document.body.classList.add('is-dragging');
    drag = { el, ghost, line, offsetY: y - r.top, offsetX: x - r.left, target: null, before: true, lastY: y };
    drag.scrollTimer = setInterval(() => autoScroll(), 30);
    move(x, y);
  }

  function autoScroll() {
    if (!drag) return;
    const r = container.getBoundingClientRect();
    if (drag.lastY < r.top + 40) container.scrollTop -= 10;
    else if (drag.lastY > r.bottom - 40) container.scrollTop += 10;
  }

  function move(x, y) {
    drag.lastY = y;
    drag.ghost.style.top = `${y - drag.offsetY}px`;
    drag.ghost.style.left = `${x - drag.offsetX}px`;
    let found = null;
    let before = true;
    for (const t of container.querySelectorAll(st.opts.targets)) {
      if (t === drag.el || t.offsetParent === null) continue;
      const r = t.getBoundingClientRect();
      if (y >= r.top && y < r.bottom) {
        found = t;
        before = y < r.top + r.height / 2;
        break;
      }
    }
    if (found && st.opts.canDrop && !st.opts.canDrop(drag.el, found, before)) found = null;
    drag.target = found;
    drag.before = before;
    if (!found) { drag.line.hidden = true; return; }
    const r = found.getBoundingClientRect();
    Object.assign(drag.line.style, { left: `${r.left}px`, width: `${r.width}px`, top: `${(before ? r.top : r.bottom) - 1}px` });
    drag.line.hidden = false;
  }
}

/* 拾光 · 工作台可调整布局（拖动分隔条 / 方向键 / 双击重置） */
(function () {
  "use strict";

  const STORAGE_KEY = "shiguang.workbench.layout.v1";
  const DEFAULTS = { school: 8, schedule: 7, topRatio: 0.36 };
  const DESKTOP = "(min-width: 1021px)";
  const HANDLE_SIZE = 16;
  const MIN_TOP = 210;
  const MIN_BOTTOM = 310;
  const MIN_SCHOOL = 5;
  const MAX_SCHOOL = 9;
  const MIN_SCHEDULE = 5;
  const MAX_SCHEDULE = 9;

  let grid;
  let cards;
  let handles;
  let resetButton;
  let layout = { ...DEFAULTS };
  let initialized = false;
  let frame = 0;
  let activeKind = "";
  let observer;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function isDesktop() {
    return window.matchMedia(DESKTOP).matches;
  }

  function readLayout() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!parsed || typeof parsed !== "object") return;
      if (Number.isFinite(Number(parsed.school))) {
        layout.school = clamp(Math.round(Number(parsed.school)), MIN_SCHOOL, MAX_SCHOOL);
      }
      if (Number.isFinite(Number(parsed.schedule))) {
        layout.schedule = clamp(Math.round(Number(parsed.schedule)), MIN_SCHEDULE, MAX_SCHEDULE);
      }
      if (Number.isFinite(Number(parsed.topRatio))) {
        layout.topRatio = clamp(Number(parsed.topRatio), 0.24, 0.68);
      }
    } catch (error) {
      layout = { ...DEFAULTS };
    }
  }

  function saveLayout() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch (error) {
      // 布局偏好不是关键数据；存储不可用时仍可在本次会话中调整。
    }
  }

  function gapSize() {
    return parseFloat(getComputedStyle(grid).rowGap) || 18;
  }

  function clearInlineLayout() {
    grid.style.removeProperty("grid-template-rows");
    for (const card of Object.values(cards)) {
      card.style.removeProperty("grid-column");
    }
  }

  function applyLayout() {
    if (!isDesktop()) {
      clearInlineLayout();
      return;
    }

    const gap = gapSize();
    const available = Math.max(0, grid.clientHeight - gap);
    const minTop = Math.min(MIN_TOP, Math.max(180, available - MIN_BOTTOM));
    const maxTop = Math.max(minTop, available - Math.min(MIN_BOTTOM, Math.max(220, available - minTop)));
    const top = clamp(Math.round(available * layout.topRatio), minTop, maxTop);
    const bottom = Math.max(180, available - top);

    grid.style.gridTemplateRows = `${top}px ${bottom}px`;
    cards.school.style.gridColumn = `1 / span ${layout.school}`;
    cards.focus.style.gridColumn = `${layout.school + 1} / span ${12 - layout.school}`;
    cards.schedule.style.gridColumn = `1 / span ${layout.schedule}`;
    cards.tasks.style.gridColumn = `${layout.schedule + 1} / span ${12 - layout.schedule}`;
  }

  function placeHandle(handle, left, top, width, height) {
    handle.style.left = `${left}px`;
    handle.style.top = `${top}px`;
    handle.style.width = `${width}px`;
    handle.style.height = `${height}px`;
  }

  function positionHandles() {
    if (!isDesktop()) return;
    const gridRect = grid.getBoundingClientRect();
    const schoolRect = cards.school.getBoundingClientRect();
    const scheduleRect = cards.schedule.getBoundingClientRect();
    const gap = gapSize();
    const lineY = schoolRect.bottom - gridRect.top + gap / 2;
    const topLineX = schoolRect.right - gridRect.left + gap / 2;
    const bottomLineX = scheduleRect.right - gridRect.left + gap / 2;

    placeHandle(handles.row, 0, lineY - HANDLE_SIZE / 2, grid.clientWidth, HANDLE_SIZE);
    placeHandle(handles.school, topLineX - HANDLE_SIZE / 2, 8, HANDLE_SIZE, Math.max(24, schoolRect.height - 16));
    placeHandle(
      handles.schedule,
      bottomLineX - HANDLE_SIZE / 2,
      scheduleRect.top - gridRect.top + 8,
      HANDLE_SIZE,
      Math.max(24, scheduleRect.height - 16)
    );
  }

  function refresh() {
    if (!grid) return;
    applyLayout();
    positionHandles();
  }

  function scheduleRefresh() {
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      refresh();
    });
  }

  function setHandleValue(handle, value, min, max) {
    handle.setAttribute("aria-valuemin", String(min));
    handle.setAttribute("aria-valuemax", String(max));
    handle.setAttribute("aria-valuenow", String(value));
  }

  function updateAria() {
    setHandleValue(handles.school, layout.school, MIN_SCHOOL, MAX_SCHOOL);
    setHandleValue(handles.schedule, layout.schedule, MIN_SCHEDULE, MAX_SCHEDULE);
    setHandleValue(handles.row, Math.round(layout.topRatio * 100), 24, 68);
  }

  function beginResize(kind, event) {
    if (!isDesktop() || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    activeKind = kind;
    document.body.classList.add("is-resizing-layout");
    document.body.style.cursor = kind === "row" ? "row-resize" : "col-resize";
    handle.classList.add("is-active");

    const onMove = (moveEvent) => {
      moveEvent.preventDefault();
      const rect = grid.getBoundingClientRect();
      if (kind === "row") {
        const gap = gapSize();
        const available = Math.max(0, grid.clientHeight - gap);
        if (!available) return;
        const top = clamp(moveEvent.clientY - rect.top, 180, available - 180);
        layout.topRatio = top / available;
      } else {
        const fraction = clamp((moveEvent.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
        const span = Math.round(fraction * 12);
        if (kind === "school") {
          layout.school = clamp(span, MIN_SCHOOL, MAX_SCHOOL);
        } else {
          layout.schedule = clamp(span, MIN_SCHEDULE, MAX_SCHEDULE);
        }
      }
      updateAria();
      scheduleRefresh();
    };

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.body.classList.remove("is-resizing-layout");
      document.body.style.removeProperty("cursor");
      handle.classList.remove("is-active");
      if (activeKind) saveLayout();
      activeKind = "";
      scheduleRefresh();
    };

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    try {
      handle.setPointerCapture(event.pointerId);
    } catch (error) {
      // 浏览器不支持指针捕获时，仍可通过全局 pointermove 调整。
    }
  }

  function resetLayout() {
    layout = { ...DEFAULTS };
    updateAria();
    refresh();
    saveLayout();
    window.dispatchEvent(new CustomEvent("shiguang:layout-reset"));
  }

  function handleKeydown(kind, event) {
    const step = event.shiftKey ? 2 : 1;
    let changed = false;
    if (kind === "school") {
      if (event.key === "ArrowLeft") {
        layout.school = clamp(layout.school - step, MIN_SCHOOL, MAX_SCHOOL);
        changed = true;
      } else if (event.key === "ArrowRight") {
        layout.school = clamp(layout.school + step, MIN_SCHOOL, MAX_SCHOOL);
        changed = true;
      }
    } else if (kind === "schedule") {
      if (event.key === "ArrowLeft") {
        layout.schedule = clamp(layout.schedule - step, MIN_SCHEDULE, MAX_SCHEDULE);
        changed = true;
      } else if (event.key === "ArrowRight") {
        layout.schedule = clamp(layout.schedule + step, MIN_SCHEDULE, MAX_SCHEDULE);
        changed = true;
      }
    } else if (kind === "row") {
      if (event.key === "ArrowUp") {
        layout.topRatio = clamp(layout.topRatio - 0.02 * step, 0.24, 0.68);
        changed = true;
      } else if (event.key === "ArrowDown") {
        layout.topRatio = clamp(layout.topRatio + 0.02 * step, 0.24, 0.68);
        changed = true;
      }
    }

    if (!changed) return;
    event.preventDefault();
    updateAria();
    refresh();
    saveLayout();
  }

  function bindHandle(handle, kind) {
    handle.addEventListener("pointerdown", (event) => beginResize(kind, event));
    handle.addEventListener("keydown", (event) => handleKeydown(kind, event));
    handle.addEventListener("dblclick", resetLayout);
  }

  function init() {
    if (initialized) return;
    grid = document.querySelector(".workbench-grid");
    if (!grid) return;
    cards = {
      school: grid.querySelector(".school-card"),
      schedule: grid.querySelector(".workbench-schedule-card"),
      focus: grid.querySelector(".focus-snapshot-card"),
      tasks: grid.querySelector(".workbench-tasks-card")
    };
    handles = {
      row: grid.querySelector('[data-resizer="row"]'),
      school: grid.querySelector('[data-resizer="school"]'),
      schedule: grid.querySelector('[data-resizer="schedule"]')
    };
    resetButton = document.querySelector("#layoutResetBtn");
    if (Object.values(cards).some((card) => !card) || Object.values(handles).some((handle) => !handle)) {
      return;
    }

    initialized = true;
    readLayout();
    updateAria();
    bindHandle(handles.row, "row");
    bindHandle(handles.school, "school");
    bindHandle(handles.schedule, "schedule");
    resetButton && resetButton.addEventListener("click", resetLayout);
    window.addEventListener("resize", scheduleRefresh, { passive: true });

    if ("ResizeObserver" in window) {
      observer = new ResizeObserver(scheduleRefresh);
      observer.observe(grid);
    }
    scheduleRefresh();
  }

  window.ShiguangLayout = {
    init,
    refresh: scheduleRefresh,
    reset: resetLayout
  };
})();

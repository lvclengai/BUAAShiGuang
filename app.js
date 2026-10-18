(function () {
  "use strict";

  const STORAGE_KEY = "shiguang.office.v1";
  const DB_NAME = "shiguang.office.db";
  const DB_VERSION = 1;
  const DB_STORE = "workspace";
  const DB_KEY = "main";
  const BEIJING_TZ = "Asia/Shanghai";
  const DAY_MS = 86400000;
  const MAX_SAFE_TEXT = 60;
  const MAX_NOTE = 160;
  const MAX_JOURNAL_TEXT = 3000;
  const MAX_JOURNAL_SUB = 1500;

  const PRIORITIES = {
    "urgent-important": { label: "重要且紧急", rank: 0 },
    important: { label: "重要不紧急", rank: 1 },
    urgent: { label: "紧急不重要", rank: 2 },
    normal: { label: "不紧急不重要", rank: 3 }
  };

  const TIMER_MODES = {
    focus: { label: "专注", duration: 25 * 60, note: "一次只做一件事" },
    short: { label: "短休息", duration: 5 * 60, note: "离开屏幕，喝口水" },
    long: { label: "长休息", duration: 15 * 60, note: "散散步，放松眼睛" }
  };

  const WEATHER_OPTIONS = {
    sunny: { label: "晴", icon: "sun" },
    cloudy: { label: "多云", icon: "cloud-sun" },
    overcast: { label: "阴", icon: "cloud" },
    rainy: { label: "雨", icon: "rain" },
    snowy: { label: "雪", icon: "snow" },
    windy: { label: "风", icon: "wind" }
  };

  const TIME_SLOTS = [
    { key: "morning", label: "上午", range: "06 – 12", start: 6, end: 12, color: "#2f6bed" },
    { key: "afternoon", label: "下午", range: "12 – 18", start: 12, end: 18, color: "#6e9df5" },
    { key: "evening", label: "晚上", range: "18 – 24", start: 18, end: 24, color: "#a7c6f7" },
    { key: "night", label: "深夜", range: "00 – 06", start: 0, end: 6, color: "#d5e3fa" }
  ];

  const RING_CIRCUMFERENCE = 653.45;
  const WEEKDAYS_SHORT = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const WEEKDAYS_TINY = ["日", "一", "二", "三", "四", "五", "六"];
  const ALLOWED_PAGES = new Set(["dashboard", "calendar", "focus", "journal"]);

  const beijingFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: BEIJING_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const dom = {};

  let state;
  let currentPage = "dashboard";
  let selectedDate = "";
  let viewYear = 0;
  let viewMonth = 0;
  let taskFilter = "active";
  let editingScheduleId = null;
  let editingTaskId = null;
  let scheduleScope = "single";
  let confirmAction = null;
  let toastTimer = null;
  let lastGreetingBand = "";
  let lastRenderedDate = "";
  let lastBeijingDate = "";
  let storageWarningShown = false;
  let audioContext = null;
  let idCounter = 0;
  let persistenceMode = "indexeddb";
  let dbPromise = null;
  let saveTimer = null;
  let saveChain = Promise.resolve();
  let focusRange = 7;
  let journalDate = "";
  let journalDirty = false;
  let journalSaveTimer = null;
  let journalLoading = false;
  let selectedWeather = "";

  const timer = {
    mode: "focus",
    total: TIMER_MODES.focus.duration,
    remaining: TIMER_MODES.focus.duration,
    running: false,
    endAt: 0,
    intervalId: null,
    completing: false
  };

  /* --------------------------------------------------------------------------
     Date & text helpers (all dates use Beijing time and YYYY-MM-DD keys)
     -------------------------------------------------------------------------- */

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function beijingParts(date = new Date()) {
    const parts = beijingFormatter.formatToParts(date);
    const map = {};
    for (const part of parts) {
      if (part.type !== "literal") map[part.type] = part.value;
    }
    return {
      year: Number(map.year),
      month: Number(map.month),
      day: Number(map.day),
      hour: Number(map.hour),
      minute: Number(map.minute),
      second: Number(map.second)
    };
  }

  function keyFromParts(year, month, day) {
    return `${String(year).padStart(4, "0")}-${pad(month)}-${pad(day)}`;
  }

  function todayKey(date = new Date()) {
    const p = beijingParts(date);
    return keyFromParts(p.year, p.month, p.day);
  }

  function isDateKey(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  }

  function dateFromKey(key) {
    const [year, month, day] = key.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day));
  }

  function keyFromDate(date) {
    return keyFromParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }

  function addDays(key, amount) {
    const date = dateFromKey(key);
    date.setUTCDate(date.getUTCDate() + amount);
    return keyFromDate(date);
  }

  function daysBetween(fromKey, toKey) {
    return Math.round((dateFromKey(toKey) - dateFromKey(fromKey)) / DAY_MS);
  }

  function partsFromKey(key) {
    const [year, month, day] = key.split("-").map(Number);
    return { year, month, day };
  }

  function weekdayIndex(key) {
    return dateFromKey(key).getUTCDay();
  }

  function weekdayShort(key) {
    return WEEKDAYS_SHORT[weekdayIndex(key)];
  }

  function weekdayChinese(key) {
    return "星期" + WEEKDAYS_TINY[weekdayIndex(key)];
  }

  function formatMonthDay(key) {
    const p = partsFromKey(key);
    return `${p.month}月${p.day}日`;
  }

  function formatShortDate(key) {
    const p = partsFromKey(key);
    return `${p.month}.${pad(p.day)}`;
  }

  function formatFullDate(key) {
    const p = partsFromKey(key);
    return `${p.year}年${p.month}月${p.day}日`;
  }

  function getISOWeek(key) {
    const date = dateFromKey(key);
    const day = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    return Math.ceil(((date - yearStart) / DAY_MS + 1) / 7);
  }

  function isToday(key) {
    return key === todayKey();
  }

  function escapeHTML(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function clampText(value, maxLength) {
    return String(value == null ? "" : value).trim().slice(0, maxLength);
  }

  function makeId(prefix = "item") {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    idCounter += 1;
    return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  function normalizeTime(value) {
    if (typeof value !== "string") return "";
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
    return match ? value : "";
  }

  function icon(name, className = "") {
    return `<svg class="${className}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  }

  /* --------------------------------------------------------------------------
     State
     -------------------------------------------------------------------------- */

  function defaultSettings() {
    return { dailyGoal: 8, sound: true };
  }

  function emptyState() {
    return {
      version: 2,
      demo: false,
      schedules: [],
      tasks: [],
      focusLogs: [],
      journals: [],
      settings: defaultSettings(),
      createdAt: new Date().toISOString()
    };
  }

  function buildDemoState() {
    const today = todayKey();
    const now = new Date().toISOString();
    const schedules = [
      {
        id: makeId("schedule"),
        title: "晨间计划与邮件整理",
        startDate: today,
        endDate: today,
        startTime: "09:00",
        endTime: "09:40",
        note: "先处理三件最重要的事。",
        done: false,
        createdAt: now
      },
      {
        id: makeId("schedule"),
        title: "产品设计评审",
        startDate: today,
        endDate: today,
        startTime: "14:30",
        endTime: "15:30",
        note: "带上新版原型和用户反馈。",
        done: false,
        createdAt: now
      },
      {
        id: makeId("schedule"),
        title: "深度工作：整理方案",
        startDate: today,
        endDate: today,
        startTime: "10:00",
        endTime: "11:30",
        note: "关掉消息提醒，只做这一件事。",
        done: false,
        createdAt: now
      },
      {
        id: makeId("schedule"),
        title: "晚间复盘与明日计划",
        startDate: today,
        endDate: today,
        startTime: "20:30",
        endTime: "20:50",
        note: "",
        done: false,
        createdAt: now
      },
      {
        id: makeId("schedule"),
        title: "季度复盘准备",
        startDate: addDays(today, -1),
        endDate: addDays(today, 1),
        startTime: "",
        endTime: "",
        note: "整理本季度关键数据。",
        done: false,
        createdAt: now
      },
      {
        id: makeId("schedule"),
        title: "每周例会",
        startDate: addDays(today, 1),
        endDate: addDays(today, 1),
        startTime: "10:00",
        endTime: "10:45",
        note: "",
        done: false,
        createdAt: now
      },
      {
        id: makeId("schedule"),
        title: "客户方案沟通",
        startDate: addDays(today, 3),
        endDate: addDays(today, 3),
        startTime: "10:00",
        endTime: "11:00",
        note: "",
        done: false,
        createdAt: now
      },
      {
        id: makeId("schedule"),
        title: "周末阅读时间",
        startDate: addDays(today, 6),
        endDate: addDays(today, 6),
        startTime: "15:00",
        endTime: "16:30",
        note: "读完桌上那本书的后半部分。",
        done: false,
        createdAt: now
      },
      {
        id: makeId("schedule"),
        title: "月度复盘",
        startDate: addDays(today, 12),
        endDate: addDays(today, 12),
        startTime: "16:00",
        endTime: "17:00",
        note: "",
        done: false,
        createdAt: now
      }
    ];

    const tasks = [
      {
        id: makeId("task"),
        title: "完成季度工作总结初稿",
        priority: "important",
        dueDate: today,
        done: false,
        createdAt: now,
        completedAt: null
      },
      {
        id: makeId("task"),
        title: "回复客户方案确认邮件",
        priority: "urgent-important",
        dueDate: addDays(today, 1),
        done: false,
        createdAt: now,
        completedAt: null
      },
      {
        id: makeId("task"),
        title: "整理下月项目排期",
        priority: "important",
        dueDate: addDays(today, 3),
        done: false,
        createdAt: now,
        completedAt: null
      },
      {
        id: makeId("task"),
        title: "归档上季度报销单据",
        priority: "urgent",
        dueDate: addDays(today, 2),
        done: false,
        createdAt: now,
        completedAt: null
      },
      {
        id: makeId("task"),
        title: "预约年度体检",
        priority: "normal",
        dueDate: null,
        done: false,
        createdAt: now,
        completedAt: null
      },
      {
        id: makeId("task"),
        title: "更新个人知识库索引",
        priority: "normal",
        dueDate: addDays(today, -1),
        done: true,
        createdAt: now,
        completedAt: now
      }
    ];

    const focusPlan = [
      [0, 3],
      [-1, 5],
      [-2, 4],
      [-4, 6],
      [-6, 2],
      [-8, 3],
      [-10, 4]
    ];
    const focusLogs = [];
    for (const [offset, count] of focusPlan) {
      const key = addDays(today, offset);
      for (let index = 0; index < count; index += 1) {
        focusLogs.push({
          id: makeId("focus"),
          date: key,
          minutes: 25,
          completedAt: new Date(`${key}T${pad(10 + (index % 8))}:20:00+08:00`).toISOString()
        });
      }
    }

    const journals = [
      {
        id: makeId("journal"),
        date: today,
        weather: "sunny",
        title: "把节奏慢下来的一天",
        content: "上午完成了季度复盘的材料整理，下午和团队过了一轮设计评审。事情很多，但一件一件做，反而没有那么慌。",
        happiness: "午休时在窗边晒了十分钟太阳，杯子里的茶刚好温热。",
        work: "理清了下一阶段的三个重点，决定明天先做最重要的一件事。",
        createdAt: now,
        updatedAt: now
      },
      {
        id: makeId("journal"),
        date: addDays(today, -1),
        weather: "cloudy",
        title: "有进展，也有留白",
        content: "整理了一周的待办，删掉了两件其实并不重要的事。晚上没有加班，慢慢走回家。",
        happiness: "楼下便利店新到了一款很好喝的酸奶。",
        work: "读完了一篇关于深度工作的文章，记下了一句：注意力在哪里，生活就在哪里。",
        createdAt: now,
        updatedAt: now
      }
    ];

    return {
      version: 2,
      demo: true,
      schedules,
      tasks,
      focusLogs,
      journals,
      settings: defaultSettings(),
      createdAt: now
    };
  }

  function normalizeState(raw) {
    const source = raw && typeof raw === "object" && raw.data ? raw.data : raw;
    if (!source || typeof source !== "object") throw new Error("备份文件格式不正确");
    if (
      !Array.isArray(source.schedules) &&
      !Array.isArray(source.tasks) &&
      !Array.isArray(source.focusLogs) &&
      !Array.isArray(source.journals)
    ) {
      throw new Error("备份文件中没有可识别的数据");
    }

    const next = emptyState();
    const scheduleIds = new Set();
    const taskIds = new Set();
    const logIds = new Set();
    const journalIds = new Set();
    const journalDates = new Set();

    for (const item of Array.isArray(source.schedules) ? source.schedules.slice(0, 20000) : []) {
      if (!item || typeof item !== "object") continue;
      const title = clampText(item.title, MAX_SAFE_TEXT);
      if (!title || !isDateKey(item.startDate)) continue;
      let endDate = isDateKey(item.endDate) ? item.endDate : item.startDate;
      if (endDate < item.startDate) endDate = item.startDate;
      let startTime = normalizeTime(item.startTime);
      let endTime = normalizeTime(item.endTime);
      if (endDate !== item.startDate) {
        startTime = "";
        endTime = "";
      } else if (!startTime || !endTime) {
        startTime = "";
        endTime = "";
      }
      let id = typeof item.id === "string" && item.id ? item.id : makeId("schedule");
      if (scheduleIds.has(id)) id = makeId("schedule");
      scheduleIds.add(id);
      next.schedules.push({
        id,
        title,
        startDate: item.startDate,
        endDate,
        startTime,
        endTime,
        note: clampText(item.note, MAX_NOTE),
        done: Boolean(item.done),
        createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString()
      });
    }

    for (const item of Array.isArray(source.tasks) ? source.tasks.slice(0, 20000) : []) {
      if (!item || typeof item !== "object") continue;
      const title = clampText(item.title, MAX_SAFE_TEXT);
      if (!title) continue;
      let id = typeof item.id === "string" && item.id ? item.id : makeId("task");
      if (taskIds.has(id)) id = makeId("task");
      taskIds.add(id);
      const priority = PRIORITIES[item.priority] ? item.priority : "important";
      next.tasks.push({
        id,
        title,
        priority,
        dueDate: isDateKey(item.dueDate) ? item.dueDate : null,
        done: Boolean(item.done),
        createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
        completedAt: typeof item.completedAt === "string" ? item.completedAt : null
      });
    }

    for (const item of Array.isArray(source.focusLogs) ? source.focusLogs.slice(0, 200000) : []) {
      if (!item || typeof item !== "object" || !isDateKey(item.date)) continue;
      const minutes = Number(item.minutes);
      if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 600) continue;
      let id = typeof item.id === "string" && item.id ? item.id : makeId("focus");
      if (logIds.has(id)) id = makeId("focus");
      logIds.add(id);
      next.focusLogs.push({
        id,
        date: item.date,
        minutes: Math.round(minutes),
        completedAt: typeof item.completedAt === "string" ? item.completedAt : `${item.date}T12:00:00+08:00`
      });
    }

    for (const item of Array.isArray(source.journals) ? source.journals.slice(0, 20000) : []) {
      if (!item || typeof item !== "object" || !isDateKey(item.date)) continue;
      if (journalDates.has(item.date)) continue;
      const title = clampText(item.title, 50);
      const content = String(item.content == null ? "" : item.content).slice(0, MAX_JOURNAL_TEXT);
      const happiness = String(item.happiness == null ? "" : item.happiness).slice(0, 1000);
      const work = String(item.work == null ? "" : item.work).slice(0, MAX_JOURNAL_SUB);
      const weather = WEATHER_OPTIONS[item.weather] ? item.weather : "";
      if (!title && !content.trim() && !happiness.trim() && !work.trim() && !weather) continue;
      let id = typeof item.id === "string" && item.id ? item.id : makeId("journal");
      if (journalIds.has(id)) id = makeId("journal");
      journalIds.add(id);
      journalDates.add(item.date);
      next.journals.push({
        id,
        date: item.date,
        weather,
        title,
        content,
        happiness,
        work,
        createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
        updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date().toISOString()
      });
    }

    if (source.settings && typeof source.settings === "object") {
      const goal = Number(source.settings.dailyGoal);
      next.settings.dailyGoal = Number.isFinite(goal) ? Math.min(24, Math.max(1, Math.round(goal))) : 8;
      next.settings.sound = source.settings.sound !== false;
    }
    next.demo = Boolean(source.demo);
    return next;
  }

  function openDatabase() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("IndexedDB 不可用"));
        return;
      }
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("IndexedDB 打开超时"));
      }, 4000);
      let request;
      try {
        request = window.indexedDB.open(DB_NAME, DB_VERSION);
      } catch (error) {
        window.clearTimeout(timeout);
        reject(error);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          db.createObjectStore(DB_STORE);
        }
      };
      request.onsuccess = () => {
        if (settled) {
          request.result.close();
          return;
        }
        settled = true;
        window.clearTimeout(timeout);
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        reject(request.error || new Error("IndexedDB 打开失败"));
      };
      request.onblocked = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        reject(new Error("IndexedDB 被其他页面占用"));
      };
    });
    return dbPromise;
  }

  async function idbReadState() {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(DB_STORE, "readonly");
      const request = transaction.objectStore(DB_STORE).get(DB_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("读取本地数据库失败"));
    });
  }

  async function idbWriteState(snapshot) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(DB_STORE, "readwrite");
      transaction.objectStore(DB_STORE).put(snapshot, DB_KEY);
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => reject(transaction.error || new Error("写入本地数据库失败"));
      transaction.onabort = () => reject(transaction.error || new Error("写入本地数据库被中止"));
    });
  }

  async function loadState() {
    let legacyRaw = null;
    try {
      legacyRaw = localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      legacyRaw = null;
    }

    let stored = null;
    try {
      stored = await idbReadState();
    } catch (error) {
      persistenceMode = "localstorage";
      console.warn("IndexedDB 不可用，使用兼容存储模式。", error);
    }

    if (stored) {
      try {
        return normalizeState(stored);
      } catch (error) {
        console.warn("本地数据库内容读取失败，尝试兼容备份。", error);
      }
    }

    if (legacyRaw) {
      try {
        const parsed = normalizeState(JSON.parse(legacyRaw));
        if (persistenceMode === "indexeddb") {
          try {
            await idbWriteState(parsed);
            localStorage.removeItem(STORAGE_KEY);
          } catch (error) {
            persistenceMode = "localstorage";
          }
        }
        return parsed;
      } catch (error) {
        console.warn("读取旧版本地数据失败，将载入示例内容。", error);
      }
    }

    const demo = buildDemoState();
    if (persistenceMode === "indexeddb") {
      try {
        await idbWriteState(demo);
        return demo;
      } catch (error) {
        persistenceMode = "localstorage";
        console.warn("写入本地数据库失败，使用兼容存储模式。", error);
      }
    }

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(demo));
    } catch (error) {
      // The app still works for this session without persistent storage.
    }
    return demo;
  }

  async function persistState(snapshot) {
    if (persistenceMode === "indexeddb") {
      try {
        await idbWriteState(snapshot);
        return;
      } catch (error) {
        persistenceMode = "localstorage";
        if (!storageWarningShown) {
          storageWarningShown = true;
          showToast("本地数据库暂时不可用，已切换到兼容存储模式");
        }
      }
    }

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch (error) {
      if (!storageWarningShown) {
        storageWarningShown = true;
        showToast("浏览器存储空间不足或不可用，请先导出备份");
      }
    }
  }

  function saveState(options = {}) {
    if (saveTimer) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (options.immediate) {
      return flushState();
    }
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      flushState();
    }, 140);
    return null;
  }

  function flushState() {
    const snapshot = state;
    saveChain = saveChain.then(() => persistState(snapshot)).catch(() => {});
    return saveChain;
  }

  async function requestPersistentStorage() {
    try {
      if (navigator.storage && typeof navigator.storage.persist === "function") {
        await navigator.storage.persist();
      }
    } catch (error) {
      // Persistence is a nice-to-have; normal storage still works.
    }
  }

  /* --------------------------------------------------------------------------
     Data queries
     -------------------------------------------------------------------------- */

  function schedulesOn(dateKey) {
    return state.schedules.filter((schedule) => schedule.startDate <= dateKey && dateKey <= schedule.endDate);
  }

  function activeTasks() {
    return state.tasks.filter((task) => !task.done);
  }

  function focusLogsOn(dateKey) {
    return state.focusLogs.filter((log) => log.date === dateKey);
  }

  function focusCountOn(dateKey) {
    return focusLogsOn(dateKey).length;
  }

  function sortedTasks(list) {
    return list.slice().sort((a, b) => {
      const aHasDue = Boolean(a.dueDate);
      const bHasDue = Boolean(b.dueDate);
      if (aHasDue !== bHasDue) return aHasDue ? -1 : 1;
      if (aHasDue && bHasDue && a.dueDate !== b.dueDate) return a.dueDate.localeCompare(b.dueDate);
      const priorityDiff = PRIORITIES[a.priority].rank - PRIORITIES[b.priority].rank;
      if (priorityDiff !== 0) return priorityDiff;
      return String(a.createdAt).localeCompare(String(b.createdAt));
    });
  }

  function sortedSchedules(list) {
    return list.slice().sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      const aTime = a.startTime || "00:00";
      const bTime = b.startTime || "00:00";
      if (aTime !== bTime) return aTime.localeCompare(bTime);
      return a.startDate.localeCompare(b.startDate);
    });
  }

  function deadlineDetails(task) {
    if (!task.dueDate) {
      return {
        primary: task.done ? "已完成" : "无截止日期",
        secondary: task.done ? "无 DDL" : "按自己的节奏",
        className: task.done ? "is-done" : "is-none"
      };
    }
    if (task.done) {
      return { primary: "已完成", secondary: `${formatShortDate(task.dueDate)} DDL`, className: "is-done" };
    }
    const remaining = daysBetween(todayKey(), task.dueDate);
    if (remaining < 0) {
      return {
        primary: `已逾期 ${Math.abs(remaining)} 天`,
        secondary: `${formatShortDate(task.dueDate)} DDL`,
        className: "is-overdue"
      };
    }
    if (remaining === 0) {
      return { primary: "今天截止", secondary: `${formatShortDate(task.dueDate)} DDL`, className: "is-today" };
    }
    return {
      primary: `还剩 ${remaining} 天`,
      secondary: `${formatShortDate(task.dueDate)} DDL`,
      className: remaining <= 3 ? "is-soon" : ""
    };
  }

  function currentStreak() {
    const activeDates = new Set(state.focusLogs.map((log) => log.date));
    let cursor = todayKey();
    if (!activeDates.has(cursor)) cursor = addDays(cursor, -1);
    let streak = 0;
    while (activeDates.has(cursor)) {
      streak += 1;
      cursor = addDays(cursor, -1);
      if (streak > 3650) break;
    }
    return streak;
  }

  function journalEntryOn(dateKey) {
    return state.journals.find((entry) => entry.date === dateKey) || null;
  }

  function journalStreak() {
    const dates = new Set(state.journals.map((entry) => entry.date));
    let cursor = todayKey();
    if (!dates.has(cursor)) cursor = addDays(cursor, -1);
    let streak = 0;
    while (dates.has(cursor)) {
      streak += 1;
      cursor = addDays(cursor, -1);
      if (streak > 3650) break;
    }
    return streak;
  }

  function journalMonthCount() {
    const prefix = todayKey().slice(0, 7);
    return state.journals.filter((entry) => entry.date.startsWith(prefix)).length;
  }

  /* --------------------------------------------------------------------------
     Rendering
     -------------------------------------------------------------------------- */

  function renderAll() {
    updateTopbar();
    renderCalendar();
    renderSchedules();
    renderTasks();
    renderWorkbenchFocus();
    renderFocusStats();
    renderJournalSidebar();
    updateTimerUI();
    updateDataStats();
  }

  function renderWorkbenchFocus() {
    if (!dom.workbenchTomatoes) return;
    const today = todayKey();
    const count = focusCountOn(today);
    const minutes = focusLogsOn(today).reduce((sum, log) => sum + (Number(log.minutes) || 0), 0);
    const round = Math.floor(count / 4) + 1;
    const goal = state.settings.dailyGoal || 8;

    dom.workbenchTomatoes.textContent = String(count);
    dom.workbenchFocusMinutes.textContent = `${minutes} 分钟专注`;
    dom.workbenchRound.textContent = `第 ${round} 轮`;
    dom.workbenchFocusCaption.textContent = count === 0
      ? "今天还没有开始，完成一个番茄试试。"
      : count >= goal
        ? "今天的专注目标已完成，保持这个节奏。"
        : `保持节奏，今天已经专注 ${minutes} 分钟。`;

    const weekDays = [];
    for (let offset = 6; offset >= 0; offset -= 1) {
      const key = addDays(today, -offset);
      weekDays.push({ key, count: focusCountOn(key) });
    }
    const maxCount = Math.max(1, ...weekDays.map((day) => day.count));
    dom.workbenchWeekBars.innerHTML = weekDays
      .map((day) => {
        const height = day.count === 0 ? 8 : Math.max(22, Math.round((day.count / maxCount) * 100));
        return `
          <span class="workbench-week-day${day.key === today ? " is-today" : ""}" title="${formatMonthDay(day.key)} · ${day.count} 个番茄">
            <i style="height:${height}%"></i>
            <small>${day.key === today ? "今" : WEEKDAYS_TINY[weekdayIndex(day.key)]}</small>
          </span>
        `;
      })
      .join("");
  }

  function renderCalendar() {
    const firstOfMonth = keyFromParts(viewYear, viewMonth, 1);
    const firstWeekday = (weekdayIndex(firstOfMonth) + 6) % 7;
    const gridStart = addDays(firstOfMonth, -firstWeekday);
    const today = todayKey();
    const focusCounts = new Map();
    for (const log of state.focusLogs) {
      focusCounts.set(log.date, (focusCounts.get(log.date) || 0) + 1);
    }

    const selectedParts = partsFromKey(selectedDate);
    const weekAnchor =
      selectedParts.year === viewYear && selectedParts.month === viewMonth ? selectedDate : firstOfMonth;
    dom.monthLabel.textContent = `${viewYear}年${viewMonth}月`;
    dom.monthSub.textContent = `第 ${getISOWeek(weekAnchor)} 周`;

    const fragment = document.createDocumentFragment();
    for (let index = 0; index < 42; index += 1) {
      const dateKey = addDays(gridStart, index);
      const dateParts = partsFromKey(dateKey);
      const inMonth = dateParts.year === viewYear && dateParts.month === viewMonth;
      const daySchedules = sortedSchedules(schedulesOn(dateKey));
      const tomatoes = focusCounts.get(dateKey) || 0;
      const isSelected = dateKey === selectedDate;
      const isCurrentDay = dateKey === today;

      const cell = document.createElement("button");
      cell.type = "button";
      cell.dataset.date = dateKey;
      cell.setAttribute("role", "gridcell");
      cell.className = [
        "cal-day",
        inMonth ? "" : "is-outside",
        isSelected ? "is-selected" : "",
        isCurrentDay ? "is-today" : "",
        weekdayIndex(dateKey) === 0 || weekdayIndex(dateKey) === 6 ? "is-weekend" : ""
      ]
        .filter(Boolean)
        .join(" ");
      cell.setAttribute("aria-label", `${formatMonthDay(dateKey)}，${weekdayChinese(dateKey)}，${daySchedules.length} 项日程，${tomatoes} 个番茄`);
      if (isCurrentDay) cell.setAttribute("aria-current", "date");
      if (isSelected) cell.setAttribute("aria-pressed", "true");
      cell.title = `${formatFullDate(dateKey)} · ${daySchedules.length} 项日程${tomatoes ? ` · ${tomatoes} 个番茄` : ""}`;

      let dots = "";
      const visibleDots = Math.min(daySchedules.length, 3);
      for (let dotIndex = 0; dotIndex < visibleDots; dotIndex += 1) {
        dots += `<span class="event-dot${daySchedules[dotIndex].done ? " is-complete" : ""}"></span>`;
      }
      if (daySchedules.length > 3) dots += `<span class="event-more">+${daySchedules.length - 3}</span>`;

      let labels = "";
      const visibleLabels = daySchedules.slice(0, 2);
      visibleLabels.forEach((schedule, labelIndex) => {
        const more =
          labelIndex === visibleLabels.length - 1 && daySchedules.length > visibleLabels.length
            ? `<em class="day-event-more">+${daySchedules.length - visibleLabels.length}</em>`
            : "";
        labels += `
          <span class="day-event${schedule.done ? " is-done" : ""}" title="${escapeHTML(schedule.title)}">
            <span>${escapeHTML(schedule.title)}</span>${more}
          </span>
        `;
      });

      let tomatoMarkup = "";
      const visibleTomatoes = Math.min(tomatoes, 4);
      for (let tomatoIndex = 0; tomatoIndex < visibleTomatoes; tomatoIndex += 1) {
        tomatoMarkup += icon("tomato", "tomato-icon");
      }
      if (tomatoes > 4) tomatoMarkup += `<span class="tomato-more">+${tomatoes - 4}</span>`;

      cell.innerHTML = `
        <span class="day-head">
          <span class="day-number">${dateParts.day}</span>
          ${isCurrentDay ? '<span class="day-today-label">今天</span>' : ""}
        </span>
        <span class="day-events">
          <span class="day-event-labels">${labels}</span>
          <span class="day-event-dots">${dots}</span>
        </span>
        <span class="day-tomatoes" aria-hidden="true">${tomatoMarkup}</span>
      `;
      cell.addEventListener("click", () => selectDate(dateKey));
      fragment.appendChild(cell);
    }

    dom.calendarGrid.replaceChildren(fragment);
  }

  function updateSelectedDateMeta() {
    const parts = partsFromKey(selectedDate);
    const currentYear = beijingParts().year;
    dom.selectedDateTitle.textContent = parts.year === currentYear
      ? `${parts.month}月${parts.day}日`
      : `${parts.year}年${parts.month}月${parts.day}日`;
    dom.selectedWeekday.textContent = weekdayShort(selectedDate);
    dom.selectedTodayBadge.hidden = !isToday(selectedDate);
  }

  function renderScheduleListInto({ dateKey, list, summary, progress, emptyTitle, emptySmall, addLabel }) {
    const items = sortedSchedules(schedulesOn(dateKey));
    const doneCount = items.filter((item) => item.done).length;
    const total = items.length;
    list.dataset.date = dateKey;

    if (total === 0) {
      summary.textContent = "暂无安排";
    } else if (doneCount > 0) {
      summary.textContent = `${total} 项日程 · 已完成 ${doneCount}`;
    } else {
      summary.textContent = `${total} 项日程`;
    }
    progress.style.width = total > 0 ? `${(doneCount / total) * 100}%` : "0%";

    if (items.length === 0) {
      list.innerHTML = `
        <div class="empty-state">
          <span class="empty-state-icon">${icon("calendar")}</span>
          <p>${escapeHTML(emptyTitle)}</p>
          <small>${escapeHTML(emptySmall)}</small>
          <button type="button" data-empty-add="schedule">${escapeHTML(addLabel)}</button>
        </div>
      `;
      return;
    }

    list.innerHTML = items
      .map((schedule) => {
        const multiDay = schedule.endDate !== schedule.startDate;
        let meta = "";
        if (multiDay) {
          const currentIndex = daysBetween(schedule.startDate, dateKey) + 1;
          const totalDays = daysBetween(schedule.startDate, schedule.endDate) + 1;
          meta = `
            <span class="meta-tag">多日 ${currentIndex}/${totalDays}</span>
            <span>${formatShortDate(schedule.startDate)} – ${formatShortDate(schedule.endDate)}</span>
          `;
        } else if (schedule.startTime && schedule.endTime) {
          meta = `<span>${escapeHTML(schedule.startTime)} – ${escapeHTML(schedule.endTime)}</span>`;
        } else {
          meta = "<span>全天</span>";
        }
        if (schedule.note) {
          meta += `<span class="meta-tag">备注</span>`;
        }

        return `
          <div class="schedule-item${schedule.done ? " is-done" : ""}" data-id="${escapeHTML(schedule.id)}">
            <button class="check-btn" type="button" data-action="toggle" aria-label="${schedule.done ? "标记为未完成" : "标记为已完成"}" aria-pressed="${schedule.done}">
              ${schedule.done ? icon("check") : ""}
            </button>
            <button class="item-main" type="button" data-action="edit" title="${escapeHTML(schedule.note || schedule.title)}">
              <span class="item-title">${escapeHTML(schedule.title)}</span>
              <span class="item-meta">${meta}</span>
            </button>
            <button class="row-edit" type="button" data-action="edit" aria-label="编辑日程">
              ${icon("edit")}
            </button>
          </div>
        `;
      })
      .join("");
  }

  function renderSchedules() {
    const today = todayKey();
    updateSelectedDateMeta();

    const todayParts = partsFromKey(today);
    dom.todayDateTitle.textContent = `${todayParts.month}月${todayParts.day}日`;
    dom.todayWeekday.textContent = weekdayShort(today);
    renderScheduleListInto({
      dateKey: today,
      list: dom.todayScheduleList,
      summary: dom.todayScheduleSummary,
      progress: dom.todayScheduleProgress,
      emptyTitle: "今天还没有安排",
      emptySmall: "给今天留一点自己的节奏",
      addLabel: "添加今天的日程"
    });

    renderScheduleListInto({
      dateKey: selectedDate,
      list: dom.scheduleList,
      summary: dom.scheduleSummary,
      progress: dom.scheduleProgress,
      emptyTitle: "这一天还没有安排",
      emptySmall: "留一点空白，也很好",
      addLabel: "添加一条日程"
    });

    const monthPrefix = `${viewYear}-${pad(viewMonth)}`;
    const monthStart = `${monthPrefix}-01`;
    const monthEnd = keyFromDate(new Date(Date.UTC(viewYear, viewMonth, 0)));
    const monthSchedules = state.schedules.filter(
      (schedule) => schedule.startDate <= monthEnd && schedule.endDate >= monthStart
    ).length;
    const monthTomatoes = state.focusLogs.filter((log) => log.date.startsWith(monthPrefix)).length;
    dom.calendarMonthSummary.textContent = `本月 ${monthSchedules} 项日程`;
    dom.calendarDayTomatoes.textContent = `${focusCountOn(selectedDate)} 个番茄`;
  }

  function renderTasks() {
    const active = activeTasks();
    const completed = state.tasks.filter((task) => task.done);
    const list = taskFilter === "done" ? completed : active;
    const sorted = sortedTasks(list);
    const counts = { "urgent-important": 0, important: 0, urgent: 0, normal: 0 };
    for (const task of active) {
      if (counts[task.priority] != null) counts[task.priority] += 1;
    }
    for (const element of $$("[data-priority-count]")) {
      element.textContent = String(counts[element.dataset.priorityCount] || 0);
    }

    dom.taskCount.textContent = String(sorted.length);
    for (const button of $$("[data-task-filter]")) {
      button.classList.toggle("is-active", button.dataset.taskFilter === taskFilter);
    }

    if (sorted.length === 0) {
      const isDoneView = taskFilter === "done";
      const hasAnyTasks = state.tasks.length > 0;
      dom.taskList.innerHTML = `
        <div class="empty-state">
          <span class="empty-state-icon">${icon(isDoneView ? "check" : "calendar")}</span>
          <p>${isDoneView ? (hasAnyTasks ? "还没有完成的任务" : "还没有任务") : "待办已经清空"}</p>
          <small>${isDoneView ? "完成一项任务后，会安静地出现在这里" : (hasAnyTasks ? "所有任务都完成了，做得不错" : "把要做的事记下来，按轻重缓急安排")}</small>
          ${isDoneView ? "" : '<button type="button" data-empty-add="task">添加一个任务</button>'}
        </div>
      `;
      return;
    }

    dom.taskList.innerHTML = sorted
      .map((task) => {
        const priority = PRIORITIES[task.priority] || PRIORITIES.important;
        const deadline = deadlineDetails(task);
        return `
          <div class="task-item priority-${escapeHTML(task.priority)}${task.done ? " is-done" : ""}" data-id="${escapeHTML(task.id)}">
            <button class="check-btn" type="button" data-action="toggle" aria-label="${task.done ? "标记为未完成" : "标记为已完成"}" aria-pressed="${task.done}">
              ${task.done ? icon("check") : ""}
            </button>
            <button class="task-main" type="button" data-action="edit" title="${escapeHTML(task.title)}">
              <span class="item-title">${escapeHTML(task.title)}</span>
              <span class="task-meta">
                <span class="priority-badge p-${escapeHTML(task.priority)}"><i class="dot dot-${task.priority === "urgent-important" ? "red" : task.priority === "urgent" ? "amber" : task.priority === "important" ? "blue" : "grey"}"></i>${escapeHTML(priority.label)}</span>
                ${task.dueDate ? `<span class="ddl-date">DDL ${formatShortDate(task.dueDate)}</span>` : ""}
              </span>
            </button>
            <span class="task-deadline ${deadline.className}">
              <span>${deadline.primary}</span>
              <small>${deadline.secondary}</small>
            </span>
          </div>
        `;
      })
      .join("");
  }

  function renderFocusStats() {
    const today = todayKey();
    const todaysLogs = focusLogsOn(today);
    const goal = state.settings.dailyGoal;
    const minutes = todaysLogs.reduce((sum, log) => sum + (Number(log.minutes) || 0), 0);
    const count = todaysLogs.length;

    dom.statTomatoes.textContent = String(count);
    dom.statMinutes.textContent = String(minutes);
    dom.statStreak.innerHTML = `${currentStreak()}<small>天</small>`;
    dom.goalCopy.textContent = `目标 ${goal} 个`;
    dom.goalFraction.textContent = `${count} / ${goal}`;
    dom.goalProgressBar.style.width = `${Math.min(100, (count / goal) * 100)}%`;

    const weekDays = [];
    let weekTotal = 0;
    for (let offset = 6; offset >= 0; offset -= 1) {
      const key = addDays(today, -offset);
      const dayCount = focusCountOn(key);
      weekTotal += dayCount;
      weekDays.push({ key, count: dayCount });
    }
    const maxCount = Math.max(1, ...weekDays.map((day) => day.count));

    dom.weekTotal.textContent = `共 ${weekTotal} 个番茄`;
    dom.weekChart.innerHTML = weekDays
      .map((day) => {
        const height = day.count === 0 ? 3 : Math.max(10, Math.round((day.count / maxCount) * 100));
        const label = day.key === today ? "今天" : WEEKDAYS_TINY[weekdayIndex(day.key)];
        return `
          <div class="week-day${day.key === today ? " is-today" : ""}" title="${formatMonthDay(day.key)} · ${day.count} 个番茄">
            <span class="week-bar-track"><i class="week-bar" style="height:${height}%"></i></span>
            <span>${label}</span>
          </div>
        `;
      })
      .join("");

    renderFocusInsights();
    updateTopbar();
  }

  function formatFocusDuration(minutes) {
    const value = Math.max(0, Math.round(minutes));
    if (value < 60) return `${value} 分钟`;
    const hours = Math.floor(value / 60);
    const rest = value % 60;
    return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
  }

  function focusRangeData(days) {
    const today = todayKey();
    const startDate = addDays(today, -(days - 1));
    const dayMap = new Map();
    const dayList = [];
    for (let offset = 0; offset < days; offset += 1) {
      const key = addDays(startDate, offset);
      const record = { key, minutes: 0, tomatoes: 0 };
      dayMap.set(key, record);
      dayList.push(record);
    }

    const slots = {};
    for (const slot of TIME_SLOTS) slots[slot.key] = { minutes: 0, count: 0 };
    let totalMinutes = 0;
    let totalTomatoes = 0;

    for (const log of state.focusLogs) {
      if (log.date < startDate || log.date > today) continue;
      const minutes = Math.max(0, Number(log.minutes) || 0);
      const record = dayMap.get(log.date);
      if (record) {
        record.minutes += minutes;
        record.tomatoes += 1;
      }
      totalMinutes += minutes;
      totalTomatoes += 1;

      let hour = 10;
      if (log.completedAt) {
        const parsed = new Date(log.completedAt);
        if (!Number.isNaN(parsed.getTime())) hour = beijingParts(parsed).hour;
      }
      const slot = TIME_SLOTS.find((item) =>
        item.start < item.end ? hour >= item.start && hour < item.end : hour >= item.start || hour < item.end
      ) || TIME_SLOTS[0];
      slots[slot.key].minutes += minutes;
      slots[slot.key].count += 1;
    }

    const goal = state.settings.dailyGoal || 8;
    const goalTotal = Math.max(1, goal * days);
    return {
      days,
      startDate,
      today,
      dayList,
      slots,
      totalMinutes,
      totalTomatoes,
      averageMinutes: days > 0 ? totalMinutes / days : 0,
      goalRate: Math.min(100, (totalTomatoes / goalTotal) * 100)
    };
  }

  function buildSmoothPath(points) {
    if (!points.length) return "";
    if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
    let path = `M ${points[0].x} ${points[0].y}`;
    for (let index = 0; index < points.length - 1; index += 1) {
      const p0 = points[Math.max(0, index - 1)];
      const p1 = points[index];
      const p2 = points[index + 1];
      const p3 = points[Math.min(points.length - 1, index + 2)];
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;
      path += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
    }
    return path;
  }

  function renderFocusInsights() {
    if (!dom.focusTrendChart) return;
    const data = focusRangeData(focusRange);
    const rangeLabel = focusRange === 7 ? "近 7 天" : `近 ${focusRange} 天`;

    const totalHours = data.totalMinutes / 60;
    dom.statsTotalFocus.textContent = data.totalMinutes >= 60
      ? String(Number(totalHours.toFixed(1)))
      : String(Math.round(data.totalMinutes));
    dom.statsTotalFocusUnit.textContent = data.totalMinutes >= 60 ? "小时" : "分钟";
    dom.statsTotalTomatoes.textContent = String(data.totalTomatoes);
    dom.statsAverage.textContent = String(Math.round(data.averageMinutes));
    dom.statsGoalRate.textContent = String(Math.round(data.goalRate));
    dom.focusTrendSummary.textContent = `${rangeLabel} · 共 ${formatFocusDuration(data.totalMinutes)}`;
    dom.trendRangeLabel.textContent = `${rangeLabel} · ${data.totalTomatoes} 个番茄`;
    dom.donutTotal.textContent = String(Math.round(data.totalMinutes));
    dom.focusTrendEmpty.hidden = data.totalTomatoes > 0;

    for (const button of $$("[data-focus-range]")) {
      button.classList.toggle("is-active", Number(button.dataset.focusRange) === focusRange);
    }

    const width = 760;
    const height = 240;
    const padding = { top: 18, right: 16, bottom: 32, left: 44 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const maxValue = Math.max(30, Math.ceil(Math.max(...data.dayList.map((day) => day.minutes), 1) / 30) * 30);
    const bottom = padding.top + plotHeight;
    const points = data.dayList.map((day, index) => ({
      x: padding.left + (data.dayList.length === 1 ? plotWidth / 2 : (index / (data.dayList.length - 1)) * plotWidth),
      y: bottom - (day.minutes / maxValue) * plotHeight,
      value: day.minutes,
      label: formatShortDate(day.key)
    }));

    const gridLines = [0, 0.5, 1].map((ratio) => {
      const y = bottom - plotHeight * ratio;
      const value = Math.round(maxValue * ratio);
      return `
        <line class="chart-grid-line" x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}"></line>
        <text class="chart-axis-label" x="${padding.left - 10}" y="${y + 3}" text-anchor="end">${value}</text>
      `;
    }).join("");

    const labelStep = Math.max(1, Math.ceil(data.dayList.length / 7));
    const xLabels = data.dayList.map((day, index) => {
      if (index !== 0 && index !== data.dayList.length - 1 && index % labelStep !== 0) return "";
      const x = points[index].x;
      return `<text class="chart-axis-label chart-x-label" x="${x}" y="${height - 8}" text-anchor="middle">${formatShortDate(day.key)}</text>`;
    }).join("");

    const linePath = buildSmoothPath(points);
    const areaPath = points.length
      ? `${linePath} L ${points[points.length - 1].x} ${bottom} L ${points[0].x} ${bottom} Z`
      : "";
    const dots = points
      .map((point) => `<circle class="chart-point" cx="${point.x}" cy="${point.y}" r="${focusRange > 14 ? 2.2 : 3.2}" data-value="${point.value}" data-label="${point.label}"><title>${point.label} · ${point.value} 分钟</title></circle>`)
      .join("");

    dom.focusTrendChart.innerHTML = `
      <defs>
        <linearGradient id="focusTrendFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#2f6bed" stop-opacity="0.18"></stop>
          <stop offset="100%" stop-color="#2f6bed" stop-opacity="0"></stop>
        </linearGradient>
      </defs>
      <g class="chart-grid">${gridLines}${xLabels}</g>
      ${data.totalMinutes > 0 ? `<path class="chart-area" d="${areaPath}"></path><path class="chart-line" d="${linePath}"></path><g class="chart-points">${dots}</g>` : ""}
    `;
    dom.focusTrendChart.setAttribute(
      "aria-label",
      `近 ${focusRange} 天专注时长趋势，总计 ${formatFocusDuration(data.totalMinutes)}，共 ${data.totalTomatoes} 个番茄`
    );

    const slotSummary = TIME_SLOTS.map((slot) => ({
      ...slot,
      minutes: data.slots[slot.key].minutes,
      count: data.slots[slot.key].count,
      percent: data.totalMinutes > 0 ? (data.slots[slot.key].minutes / data.totalMinutes) * 100 : 0
    }));
    let cursor = 0;
    const segments = [];
    for (const slot of slotSummary) {
      if (slot.minutes <= 0) continue;
      const end = cursor + slot.percent;
      segments.push(`${slot.color} ${cursor.toFixed(2)}% ${end.toFixed(2)}%`);
      cursor = end;
    }
    dom.focusDonut.style.background = segments.length
      ? `conic-gradient(${segments.join(", ")})`
      : "conic-gradient(#eef2f9 0% 100%)";
    dom.focusDonut.setAttribute(
      "aria-label",
      data.totalMinutes > 0
        ? `专注时段占比：${slotSummary.map((slot) => `${slot.label}${Math.round(slot.percent)}%`).join("，")}`
        : "暂无专注记录"
    );
    dom.focusDistribution.innerHTML = slotSummary
      .map(
        (slot) => `
          <div class="donut-legend-item">
            <i style="background:${slot.color}"></i>
            <span class="donut-legend-label"><strong>${slot.label}</strong><small>${slot.range}</small></span>
            <span class="donut-legend-value"><strong>${Math.round(slot.percent)}%</strong><small>${slot.minutes} 分钟</small></span>
          </div>
        `
      )
      .join("");
  }

  function updateTopbar() {
    if (!state) return;
    const now = new Date();
    const parts = beijingParts(now);
    const today = keyFromParts(parts.year, parts.month, parts.day);
    const hour = parts.hour;
    const greetingBand = hour < 5 ? "night" : hour < 9 ? "morning" : hour < 12 ? "forenoon" : hour < 14 ? "noon" : hour < 18 ? "afternoon" : hour < 22 ? "evening" : "late";

    dom.topbarDate.textContent = `${parts.month}月${parts.day}日 · ${weekdayChinese(today)}`;

    const greetings = {
      night: "夜深了，也别忘了休息。",
      morning: "早上好，今天从容一点。",
      forenoon: "上午好，先做重要的事。",
      noon: "中午好，记得稍作休息。",
      afternoon: "下午好，把重要的事做好。",
      evening: "晚上好，收尾也从容。",
      late: "夜深了，早点收工。"
    };

    const pageTitles = {
      dashboard: greetings[greetingBand],
      calendar: "把日子，安排得从容一点。",
      focus: "留一点安静，专注一件事。",
      journal: "写下今天，留住一点生活。"
    };
    dom.topbarTitle.textContent = pageTitles[currentPage] || pageTitles.dashboard;
    lastGreetingBand = greetingBand;

    if (currentPage === "calendar") {
      const monthPrefix = `${viewYear}-${pad(viewMonth)}`;
      const monthStart = `${monthPrefix}-01`;
      const monthEnd = keyFromDate(new Date(Date.UTC(viewYear, viewMonth, 0)));
      const monthSchedules = state.schedules.filter(
        (schedule) => schedule.startDate <= monthEnd && schedule.endDate >= monthStart
      );
      const monthDone = monthSchedules.filter((schedule) => schedule.done).length;
      const monthTomatoes = state.focusLogs.filter((log) => log.date.startsWith(monthPrefix)).length;
      dom.topbarSummary.textContent = `本月 ${monthSchedules.length} 项日程 · ${monthDone} 项已完成 · ${monthTomatoes} 个番茄`;
    } else if (currentPage === "journal") {
      dom.topbarSummary.textContent = `已记录 ${state.journals.length} 篇日记 · 连续 ${journalStreak()} 天 · 本月 ${journalMonthCount()} 篇`;
    } else {
      const todaySchedules = schedulesOn(today).length;
      const todo = activeTasks().length;
      const tomatoes = focusCountOn(today);
      dom.topbarSummary.textContent = `今天 ${todaySchedules} 项日程 · ${todo} 个任务待办 · ${tomatoes} 个番茄`;
    }
    lastRenderedDate = today;
  }

  function updateDataStats() {
    if (!dom.dataStats) return;
    dom.dataStats.textContent = `${state.schedules.length} 项日程 · ${state.tasks.length} 个任务 · ${state.journals.length} 篇日记`;
    dom.demoNote.hidden = !state.demo;
    dom.demoBadge.hidden = !state.demo;
  }

  /* --------------------------------------------------------------------------
     Calendar & lists
     -------------------------------------------------------------------------- */

  function setViewToDate(dateKey) {
    const parts = partsFromKey(dateKey);
    viewYear = parts.year;
    viewMonth = parts.month;
  }

  function selectDate(dateKey) {
    selectedDate = dateKey;
    setViewToDate(dateKey);
    renderCalendar();
    renderSchedules();
    updateTopbar();
  }

  function shiftMonth(amount) {
    let month = viewMonth + amount;
    let year = viewYear;
    if (month < 1) {
      month = 12;
      year -= 1;
    } else if (month > 12) {
      month = 1;
      year += 1;
    }
    const first = keyFromParts(year, month, 1);
    viewYear = year;
    viewMonth = month;
    selectedDate = first;
    renderCalendar();
    renderSchedules();
    updateTopbar();
  }

  function goToToday() {
    selectedDate = todayKey();
    setViewToDate(selectedDate);
    renderCalendar();
    renderSchedules();
    updateTopbar();
  }

  /* --------------------------------------------------------------------------
     Page navigation
     -------------------------------------------------------------------------- */

  function setPage(page, updateHash = true) {
    if (!ALLOWED_PAGES.has(page)) page = "dashboard";
    if (currentPage === "journal" && journalDirty) {
      saveJournal({ auto: true, silent: true });
    }
    currentPage = page;
    dom.dashboardView.hidden = page !== "dashboard";
    dom.dashboardView.classList.toggle("is-active", page === "dashboard");
    dom.calendarView.hidden = page !== "calendar";
    dom.calendarView.classList.toggle("is-active", page === "calendar");
    dom.focusView.hidden = page !== "focus";
    dom.focusView.classList.toggle("is-active", page === "focus");
    dom.journalView.hidden = page !== "journal";
    dom.journalView.classList.toggle("is-active", page === "journal");
    dom.newScheduleBtn.hidden = page !== "dashboard" && page !== "calendar";
    for (const button of $$("[data-page-target]")) {
      button.classList.toggle("is-active", button.dataset.pageTarget === page);
    }
    if (page === "focus") updateTimerUI();
    if (page === "journal") {
      if (!journalDate) journalDate = todayKey();
      renderJournalEditor();
      renderJournalSidebar();
    }
    updateTopbar();
    if (updateHash) {
      try {
        history.replaceState(null, "", `#${page}`);
      } catch (error) {
        // Ignore history restrictions on local files.
      }
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /* --------------------------------------------------------------------------
     Clock
     -------------------------------------------------------------------------- */

  function tickClock() {
    const now = new Date();
    const parts = beijingParts(now);
    const hh = pad(parts.hour);
    const mm = pad(parts.minute);
    const ss = pad(parts.second);
    const today = keyFromParts(parts.year, parts.month, parts.day);

    dom.topClockTime.textContent = `${hh}:${mm}`;
    dom.topClockSeconds.textContent = `:${ss}`;
    dom.focusClockTime.textContent = `${hh}:${mm}`;
    dom.focusClockSeconds.textContent = `:${ss}`;
    dom.focusClockDate.textContent = `${parts.year}年${parts.month}月${parts.day}日 · ${weekdayChinese(today)}`;
    dom.weekLabel.textContent = `第 ${getISOWeek(today)} 周`;

    const dayPercent = ((parts.hour * 3600 + parts.minute * 60 + parts.second) / 86400) * 100;
    dom.dayProgressLabel.textContent = `已过 ${Math.floor(dayPercent)}%`;
    dom.dayProgressBar.style.width = `${dayPercent}%`;

    if (today !== lastBeijingDate) {
      const wasFollowingToday = selectedDate === lastBeijingDate || !lastBeijingDate;
      const journalWasToday = journalDate === lastBeijingDate || !journalDate;
      lastBeijingDate = today;
      if (wasFollowingToday) {
        selectedDate = today;
        setViewToDate(today);
      }
      if (journalWasToday && !journalDirty) {
        journalDate = today;
        renderJournalEditor();
      }
      updateTopbar();
      renderCalendar();
      renderSchedules();
      renderFocusStats();
      renderWorkbenchFocus();
      renderJournalSidebar();
      updateDataStats();
    } else if (today !== lastRenderedDate) {
      updateTopbar();
    }
  }

  /* --------------------------------------------------------------------------
     Timer
     -------------------------------------------------------------------------- */

  function stopTimerInterval() {
    if (timer.intervalId) {
      clearInterval(timer.intervalId);
      timer.intervalId = null;
    }
  }

  function ensureAudioContext() {
    if (!state.settings.sound) return;
    try {
      if (!audioContext) {
        const AudioCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtor) return;
        audioContext = new AudioCtor();
      }
      if (audioContext.state === "suspended") {
        audioContext.resume().catch(() => {});
      }
    } catch (error) {
      audioContext = null;
    }
  }

  function playChime() {
    if (!state.settings.sound || !audioContext) return;
    try {
      const now = audioContext.currentTime;
      const notes = [
        { frequency: 659.25, start: 0, duration: 0.25 },
        { frequency: 880.0, start: 0.18, duration: 0.38 }
      ];
      for (const note of notes) {
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = note.frequency;
        gain.gain.setValueAtTime(0.0001, now + note.start);
        gain.gain.exponentialRampToValueAtTime(0.11, now + note.start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + note.start + note.duration);
        oscillator.connect(gain).connect(audioContext.destination);
        oscillator.start(now + note.start);
        oscillator.stop(now + note.start + note.duration + 0.02);
      }
    } catch (error) {
      // Audio is a nicety, never a blocker.
    }
  }

  function setTimerMode(mode, options = {}) {
    if (!TIMER_MODES[mode]) return;
    stopTimerInterval();
    timer.mode = mode;
    timer.total = TIMER_MODES[mode].duration;
    timer.remaining = timer.total;
    timer.running = false;
    timer.endAt = 0;
    timer.completing = false;
    updateTimerUI();
    updateDocumentTitle();
    if (options.toast) showToast(`已切换到${TIMER_MODES[mode].label}`);
  }

  function startTimer() {
    if (timer.running) {
      pauseTimer();
      return;
    }
    if (timer.remaining <= 0) timer.remaining = timer.total;
    ensureAudioContext();
    timer.running = true;
    timer.endAt = Date.now() + timer.remaining * 1000;
    stopTimerInterval();
    timer.intervalId = window.setInterval(tickTimer, 250);
    updateTimerUI();
    updateDocumentTitle();
  }

  function pauseTimer() {
    if (!timer.running) return;
    timer.remaining = Math.max(0, Math.ceil((timer.endAt - Date.now()) / 1000));
    timer.running = false;
    stopTimerInterval();
    updateTimerUI();
    updateDocumentTitle();
  }

  function resetTimer(options = {}) {
    stopTimerInterval();
    timer.running = false;
    timer.endAt = 0;
    timer.total = TIMER_MODES[timer.mode].duration;
    timer.remaining = timer.total;
    updateTimerUI();
    updateDocumentTitle();
    if (options.toast) showToast("计时已重置");
  }

  function tickTimer() {
    if (!timer.running) return;
    const nextRemaining = Math.max(0, Math.ceil((timer.endAt - Date.now()) / 1000));
    if (nextRemaining !== timer.remaining) {
      timer.remaining = nextRemaining;
      updateTimerUI();
      updateDocumentTitle();
    }
    if (nextRemaining <= 0) completeTimer();
  }

  function addFocusLog(minutes) {
    state.focusLogs.push({
      id: makeId("focus"),
      date: todayKey(),
      minutes,
      completedAt: new Date().toISOString()
    });
    saveState();
  }

  function completeTimer() {
    if (timer.completing) return;
    timer.completing = true;
    stopTimerInterval();
    timer.running = false;
    const finishedMode = timer.mode;
    timer.remaining = 0;
    updateTimerUI();
    updateDocumentTitle();

    if (finishedMode === "focus") {
      addFocusLog(Math.round(TIMER_MODES.focus.duration / 60));
      playChime();
      const countToday = focusCountOn(todayKey());
      const nextMode = countToday > 0 && countToday % 4 === 0 ? "long" : "short";
      const nextLabel = TIMER_MODES[nextMode].label;
      timer.mode = nextMode;
      timer.total = TIMER_MODES[nextMode].duration;
      timer.remaining = timer.total;
      timer.endAt = 0;
      showToast(`完成 1 个番茄，已记入日历 · 接着${nextLabel}吧`, 3800);
      renderAll();
    } else {
      playChime();
      timer.mode = "focus";
      timer.total = TIMER_MODES.focus.duration;
      timer.remaining = timer.total;
      timer.endAt = 0;
      showToast("休息结束，回到专注吧", 3000);
      renderAll();
    }

    timer.completing = false;
    updateTimerUI();
    updateDocumentTitle();
  }

  function skipTimerPhase() {
    stopTimerInterval();
    timer.running = false;
    timer.endAt = 0;
    if (timer.mode === "focus") {
      const todayCount = focusCountOn(todayKey());
      timer.mode = todayCount > 0 && todayCount % 4 === 0 ? "long" : "short";
    } else {
      timer.mode = "focus";
    }
    timer.total = TIMER_MODES[timer.mode].duration;
    timer.remaining = timer.total;
    updateTimerUI();
    updateDocumentTitle();
    showToast(`已跳至${TIMER_MODES[timer.mode].label}`);
  }

  function cycleInfo() {
    const count = focusCountOn(todayKey());
    const remainder = count % 4;
    let filled = remainder;
    if (count > 0 && remainder === 0) filled = 4;
    const round = Math.floor(count / 4) + 1;
    return { count, filled, round };
  }

  function updateTimerUI() {
    if (!dom.timerDisplay) return;
    const minutes = Math.floor(timer.remaining / 60);
    const seconds = timer.remaining % 60;
    const mode = TIMER_MODES[timer.mode];
    const elapsedRatio = timer.total > 0 ? Math.min(1, Math.max(0, 1 - timer.remaining / timer.total)) : 0;

    dom.timerDisplay.textContent = `${pad(minutes)}:${pad(seconds)}`;
    dom.timerModeLabel.textContent = mode.label;
    dom.timerNote.textContent = timer.running
      ? timer.mode === "focus"
        ? "保持专注，屏蔽打扰"
        : "好好休息，恢复精力"
      : mode.note;
    dom.timerRingProgress.style.strokeDasharray = String(RING_CIRCUMFERENCE);
    dom.timerRingProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - elapsedRatio));

    let startLabel = "开始专注";
    if (timer.mode !== "focus") startLabel = "开始休息";
    if (timer.running) startLabel = "暂停计时";
    else if (timer.remaining < timer.total) startLabel = "继续";
    dom.timerStartLabel.textContent = startLabel;
    dom.timerStartBtn.classList.toggle("is-running", timer.running);
    dom.timerStartIcon.innerHTML = `<use href="#i-${timer.running ? "pause" : "play"}"></use>`;

    for (const button of $$("[data-timer-mode]")) {
      button.classList.toggle("is-active", button.dataset.timerMode === timer.mode);
    }

    const cycle = cycleInfo();
    dom.roundLabel.textContent = `第 ${cycle.round} 轮`;
    let dots = "";
    for (let index = 0; index < 4; index += 1) {
      const isFilled = index < cycle.filled;
      const isCurrent = !isFilled && index === cycle.filled;
      dots += `<span class="cycle-dot${isFilled ? " is-filled" : ""}${isCurrent ? " is-current" : ""}"></span>`;
    }
    dom.cycleDots.innerHTML = dots;
    dom.cycleDots.setAttribute("aria-label", `今天已完成 ${cycle.count} 个番茄`);

    dom.navRunningDot.hidden = !timer.running;
  }

  function updateDocumentTitle() {
    if (timer.running) {
      const minutes = Math.floor(timer.remaining / 60);
      const seconds = timer.remaining % 60;
      document.title = `${pad(minutes)}:${pad(seconds)} · ${TIMER_MODES[timer.mode].label}中 · 拾光`;
    } else {
      document.title = "拾光 · 日常办公工作台";
    }
  }

  /* --------------------------------------------------------------------------
     Schedule dialog
     -------------------------------------------------------------------------- */

  function setScheduleScope(scope) {
    scheduleScope = scope === "multi" ? "multi" : "single";
    for (const button of $$("[data-scope]")) {
      button.classList.toggle("is-active", button.dataset.scope === scheduleScope);
    }
    const isMulti = scheduleScope === "multi";
    dom.scheduleEndField.hidden = !isMulti;
    dom.scheduleTimeRow.hidden = isMulti;
    dom.scheduleDateRow.classList.toggle("is-single", !isMulti);
    dom.startDateLabel.textContent = isMulti ? "开始日期" : "日期";
    dom.scheduleEnd.min = dom.scheduleStart.value;
    if (isMulti && (!dom.scheduleEnd.value || dom.scheduleEnd.value < dom.scheduleStart.value)) {
      dom.scheduleEnd.value = dom.scheduleStart.value;
    }
  }

  function openScheduleDialog(schedule = null, preferredDate = selectedDate) {
    editingScheduleId = schedule ? schedule.id : null;
    dom.scheduleForm.reset();
    hideFormError(dom.scheduleError);

    if (schedule) {
      dom.scheduleDialogEyebrow.textContent = "EDIT SCHEDULE";
      dom.scheduleDialogTitle.textContent = "编辑日程";
      dom.saveScheduleBtn.textContent = "保存修改";
      dom.deleteScheduleBtn.hidden = false;
      dom.scheduleTitle.value = schedule.title;
      dom.scheduleStart.value = schedule.startDate;
      dom.scheduleEnd.value = schedule.endDate;
      dom.scheduleStartTime.value = schedule.startTime || "";
      dom.scheduleEndTime.value = schedule.endTime || "";
      dom.scheduleNote.value = schedule.note || "";
      setScheduleScope(schedule.endDate !== schedule.startDate ? "multi" : "single");
    } else {
      dom.scheduleDialogEyebrow.textContent = "NEW SCHEDULE";
      dom.scheduleDialogTitle.textContent = "新建日程";
      dom.saveScheduleBtn.textContent = "保存日程";
      dom.deleteScheduleBtn.hidden = true;
      const date = preferredDate || selectedDate || todayKey();
      dom.scheduleStart.value = date;
      dom.scheduleEnd.value = date;
      dom.scheduleStartTime.value = "";
      dom.scheduleEndTime.value = "";
      dom.scheduleNote.value = "";
      setScheduleScope("single");
    }

    dom.scheduleDialog.showModal();
    window.setTimeout(() => dom.scheduleTitle.focus(), 30);
  }

  function saveSchedule(event) {
    event.preventDefault();
    hideFormError(dom.scheduleError);

    const title = dom.scheduleTitle.value.trim();
    const startDate = dom.scheduleStart.value;
    const isMulti = scheduleScope === "multi";
    const endDate = isMulti ? dom.scheduleEnd.value : startDate;
    const startTime = isMulti ? "" : dom.scheduleStartTime.value;
    const endTime = isMulti ? "" : dom.scheduleEndTime.value;

    if (!title) {
      showFormError(dom.scheduleError, "请填写日程标题。");
      dom.scheduleTitle.focus();
      return;
    }
    if (!isDateKey(startDate)) {
      showFormError(dom.scheduleError, "请选择有效的日程日期。");
      return;
    }
    if (isMulti && !isDateKey(endDate)) {
      showFormError(dom.scheduleError, "请选择多日日程的结束日期。");
      return;
    }
    if (isMulti && endDate < startDate) {
      showFormError(dom.scheduleError, "结束日期不能早于开始日期。");
      return;
    }
    if (daysBetween(startDate, endDate) > 366) {
      showFormError(dom.scheduleError, "多日日程的跨度请控制在一年以内。");
      return;
    }
    if (!isMulti && Boolean(startTime) !== Boolean(endTime)) {
      showFormError(dom.scheduleError, "请同时填写开始时间和结束时间，或都留空设为全天。");
      return;
    }
    if (startTime && endTime && endTime <= startTime) {
      showFormError(dom.scheduleError, "结束时间需要晚于开始时间。");
      return;
    }

    const existing = editingScheduleId ? state.schedules.find((item) => item.id === editingScheduleId) : null;
    const schedule = {
      id: existing ? existing.id : makeId("schedule"),
      title: clampText(title, MAX_SAFE_TEXT),
      startDate,
      endDate,
      startTime,
      endTime,
      note: clampText(dom.scheduleNote.value, MAX_NOTE),
      done: existing ? existing.done : false,
      createdAt: existing ? existing.createdAt : new Date().toISOString()
    };

    if (existing) {
      state.schedules = state.schedules.map((item) => (item.id === existing.id ? schedule : item));
    } else {
      state.schedules.push(schedule);
    }
    state.demo = false;
    saveState();
    selectedDate = startDate;
    setViewToDate(selectedDate);
    dom.scheduleDialog.close();
    renderAll();
    showToast(existing ? "日程已更新" : "日程已创建");
  }

  function deleteSchedule() {
    if (!editingScheduleId) return;
    const schedule = state.schedules.find((item) => item.id === editingScheduleId);
    if (!schedule) return;
    showConfirm({
      title: "删除这条日程？",
      text: `「${schedule.title}」将从日历中移除，此操作无法撤销。`,
      okLabel: "删除日程",
      onConfirm: () => {
        state.schedules = state.schedules.filter((item) => item.id !== schedule.id);
        state.demo = false;
        saveState();
        dom.scheduleDialog.close();
        renderAll();
        showToast("日程已删除");
      }
    });
  }

  /* --------------------------------------------------------------------------
     Task dialog
     -------------------------------------------------------------------------- */

  function syncTaskDueState() {
    const noDue = dom.taskNoDue.checked;
    dom.taskDue.disabled = noDue;
    dom.taskDue.classList.toggle("is-disabled", noDue);
    dom.taskDueHint.hidden = !noDue;
  }

  function openTaskDialog(task = null) {
    editingTaskId = task ? task.id : null;
    dom.taskForm.reset();
    hideFormError(dom.taskError);

    if (task) {
      dom.taskDialogEyebrow.textContent = "EDIT TASK";
      dom.taskDialogTitle.textContent = "编辑任务";
      dom.saveTaskBtn.textContent = "保存修改";
      dom.deleteTaskBtn.hidden = false;
      dom.taskTitle.value = task.title;
      dom.taskNoDue.checked = !task.dueDate;
      dom.taskDue.value = task.dueDate || addDays(todayKey(), 1);
      const radio = $(`input[name="priority"][value="${task.priority}"]`, dom.taskForm);
      if (radio) radio.checked = true;
    } else {
      dom.taskDialogEyebrow.textContent = "NEW TASK";
      dom.taskDialogTitle.textContent = "新建任务";
      dom.saveTaskBtn.textContent = "保存任务";
      dom.deleteTaskBtn.hidden = true;
      dom.taskNoDue.checked = false;
      dom.taskDue.value = addDays(todayKey(), 1);
      const radio = $('input[name="priority"][value="urgent-important"]', dom.taskForm);
      if (radio) radio.checked = true;
    }
    syncTaskDueState();

    dom.taskDialog.showModal();
    window.setTimeout(() => dom.taskTitle.focus(), 30);
  }

  function saveTask(event) {
    event.preventDefault();
    hideFormError(dom.taskError);

    const title = dom.taskTitle.value.trim();
    const noDue = dom.taskNoDue.checked;
    const dueDate = noDue ? null : dom.taskDue.value;
    const selectedPriority = $('input[name="priority"]:checked', dom.taskForm);
    const priority = selectedPriority ? selectedPriority.value : "important";

    if (!title) {
      showFormError(dom.taskError, "请填写任务内容。");
      dom.taskTitle.focus();
      return;
    }
    if (!noDue && !isDateKey(dueDate)) {
      showFormError(dom.taskError, "请选择任务的截止日期。");
      return;
    }

    const existing = editingTaskId ? state.tasks.find((item) => item.id === editingTaskId) : null;
    const task = {
      id: existing ? existing.id : makeId("task"),
      title: clampText(title, MAX_SAFE_TEXT),
      priority: PRIORITIES[priority] ? priority : "important",
      dueDate,
      done: existing ? existing.done : false,
      createdAt: existing ? existing.createdAt : new Date().toISOString(),
      completedAt: existing ? existing.completedAt : null
    };

    if (existing) {
      state.tasks = state.tasks.map((item) => (item.id === existing.id ? task : item));
    } else {
      state.tasks.push(task);
    }
    state.demo = false;
    saveState();
    if (!task.done && taskFilter === "done") taskFilter = "active";
    dom.taskDialog.close();
    renderAll();
    showToast(existing ? "任务已更新" : "任务已创建");
  }

  function deleteTask() {
    if (!editingTaskId) return;
    const task = state.tasks.find((item) => item.id === editingTaskId);
    if (!task) return;
    showConfirm({
      title: "删除这个任务？",
      text: `「${task.title}」将从任务清单中移除，此操作无法撤销。`,
      okLabel: "删除任务",
      onConfirm: () => {
        state.tasks = state.tasks.filter((item) => item.id !== task.id);
        state.demo = false;
        saveState();
        dom.taskDialog.close();
        renderAll();
        showToast("任务已删除");
      }
    });
  }

  /* --------------------------------------------------------------------------
     Journal
     -------------------------------------------------------------------------- */

  function journalValues() {
    return {
      weather: selectedWeather,
      title: dom.journalTitleInput.value.trim(),
      content: dom.journalContentInput.value,
      happiness: dom.journalHappinessInput.value,
      work: dom.journalWorkInput.value
    };
  }

  function hasJournalContent(values) {
    return Boolean(
      values.weather ||
      values.title ||
      values.content.trim() ||
      values.happiness.trim() ||
      values.work.trim()
    );
  }

  function updateWeatherButtons() {
    for (const button of $$("[data-weather]", dom.weatherOptions)) {
      const active = button.dataset.weather === selectedWeather;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    }
  }

  function formatSavedTime(iso) {
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime())) return "刚刚";
    const parts = beijingParts(parsed);
    return `${pad(parts.hour)}:${pad(parts.minute)}`;
  }

  function renderJournalEditor() {
    if (!dom.journalDateTitle) return;
    if (!isDateKey(journalDate)) journalDate = todayKey();
    const entry = journalEntryOn(journalDate);
    const parts = partsFromKey(journalDate);
    const currentYear = beijingParts().year;

    dom.journalDateTitle.textContent = parts.year === currentYear
      ? `${parts.month}月${parts.day}日`
      : `${parts.year}年${parts.month}月${parts.day}日`;
    dom.journalWeekday.textContent = weekdayShort(journalDate);
    dom.journalTodayBadge.hidden = !isToday(journalDate);
    dom.journalDateInput.value = journalDate;

    dom.journalTitleInput.value = entry ? entry.title : "";
    dom.journalContentInput.value = entry ? entry.content : "";
    dom.journalHappinessInput.value = entry ? entry.happiness : "";
    dom.journalWorkInput.value = entry ? entry.work : "";
    selectedWeather = entry && WEATHER_OPTIONS[entry.weather] ? entry.weather : "";
    updateWeatherButtons();

    journalDirty = false;
    if (journalSaveTimer) {
      window.clearTimeout(journalSaveTimer);
      journalSaveTimer = null;
    }
    dom.journalSaveStatus.textContent = entry
      ? `已保存 · ${formatSavedTime(entry.updatedAt)}`
      : "还没有记录";
    renderJournalSidebar();
  }

  function markJournalDirty() {
    journalDirty = true;
    dom.journalSaveStatus.textContent = "未保存";
    if (journalSaveTimer) window.clearTimeout(journalSaveTimer);
    journalSaveTimer = window.setTimeout(() => {
      journalSaveTimer = null;
      saveJournal({ auto: true, silent: true });
    }, 900);
  }

  function saveJournal(options = {}) {
    if (!journalDate) journalDate = todayKey();
    const values = journalValues();
    const existing = journalEntryOn(journalDate);
    const empty = !hasJournalContent(values);

    if (empty && !existing) {
      if (!options.silent) showToast("今天的日记还是空的");
      dom.journalSaveStatus.textContent = "还没有记录";
      journalDirty = false;
      return false;
    }

    if (empty && existing) {
      state.journals = state.journals.filter((entry) => entry.id !== existing.id);
      state.demo = false;
      journalDirty = false;
      if (journalSaveTimer) {
        window.clearTimeout(journalSaveTimer);
        journalSaveTimer = null;
      }
      saveState();
      dom.journalSaveStatus.textContent = "还没有记录";
      renderJournalSidebar();
      updateTopbar();
      updateDataStats();
      if (!options.silent) showToast("日记已清空");
      return true;
    }

    const now = new Date().toISOString();
    if (existing) {
      existing.weather = values.weather;
      existing.title = clampText(values.title, 50);
      existing.content = values.content.slice(0, MAX_JOURNAL_TEXT);
      existing.happiness = values.happiness.slice(0, 1000);
      existing.work = values.work.slice(0, MAX_JOURNAL_SUB);
      existing.updatedAt = now;
    } else {
      state.journals.push({
        id: makeId("journal"),
        date: journalDate,
        weather: values.weather,
        title: clampText(values.title, 50),
        content: values.content.slice(0, MAX_JOURNAL_TEXT),
        happiness: values.happiness.slice(0, 1000),
        work: values.work.slice(0, MAX_JOURNAL_SUB),
        createdAt: now,
        updatedAt: now
      });
    }

    state.demo = false;
    journalDirty = false;
    if (journalSaveTimer) {
      window.clearTimeout(journalSaveTimer);
      journalSaveTimer = null;
    }
    saveState();
    const saveTime = formatSavedTime(now);
    dom.journalSaveStatus.textContent = options.auto ? `已自动保存 · ${saveTime}` : `已保存 · ${saveTime}`;
    renderJournalSidebar();
    updateTopbar();
    updateDataStats();
    if (!options.silent) showToast(existing ? "日记已更新" : "日记已保存");
    return true;
  }

  function setJournalDate(dateKey) {
    if (!isDateKey(dateKey) || dateKey === journalDate) return;
    if (journalDirty) saveJournal({ auto: true, silent: true });
    journalDate = dateKey;
    renderJournalEditor();
    updateTopbar();
  }

  function stepJournalDate(amount) {
    setJournalDate(addDays(journalDate || todayKey(), amount));
  }

  function journalPreview(entry) {
    const chunks = [entry.title, entry.content, entry.happiness, entry.work].filter(Boolean);
    return chunks.length ? chunks.join(" ").replace(/\s+/g, " ").trim() : "还没有写下内容";
  }

  function renderJournalSidebar() {
    if (!dom.journalList) return;
    const entries = state.journals.slice().sort((a, b) => b.date.localeCompare(a.date));
    dom.journalTotal.textContent = String(entries.length);
    dom.journalStreak.textContent = String(journalStreak());
    dom.journalMonthCount.textContent = String(journalMonthCount());
    dom.journalCount.textContent = String(entries.length);

    if (!entries.length) {
      dom.journalList.innerHTML = `
        <div class="empty-state journal-empty">
          <span class="empty-state-icon">${icon("journal")}</span>
          <p>还没有日记</p>
          <small>从今天开始，记下一点生活</small>
          <button type="button" data-journal-today>写今天的日记</button>
        </div>
      `;
      return;
    }

    dom.journalList.innerHTML = entries
      .slice(0, 60)
      .map((entry) => {
        const parts = partsFromKey(entry.date);
        const weather = WEATHER_OPTIONS[entry.weather];
        const preview = escapeHTML(journalPreview(entry));
        return `
          <button class="journal-entry${entry.date === journalDate ? " is-active" : ""}" type="button" data-journal-date="${entry.date}">
            <span class="journal-entry-date">
              <strong>${parts.day}</strong>
              <small>${parts.month}月</small>
            </span>
            <span class="journal-entry-main">
              <span class="journal-entry-title">${escapeHTML(entry.title || "无标题")}</span>
              <span class="journal-entry-preview">${weather ? `${weather.label} · ` : ""}${preview}</span>
            </span>
            <svg class="journal-entry-arrow" aria-hidden="true"><use href="#i-chevron-right"></use></svg>
          </button>
        `;
      })
      .join("");
  }

  /* --------------------------------------------------------------------------
     Data dialog
     -------------------------------------------------------------------------- */

  function syncSettingsUI() {
    dom.dailyGoalInput.value = String(state.settings.dailyGoal);
    dom.soundToggle.checked = Boolean(state.settings.sound);
    updateDataStats();
  }

  function openDataDialog() {
    syncSettingsUI();
    dom.dataDialog.showModal();
  }

  function setDailyGoal(value) {
    const parsed = Number(value);
    const goal = Number.isFinite(parsed) ? Math.min(24, Math.max(1, Math.round(parsed))) : 8;
    state.settings.dailyGoal = goal;
    dom.dailyGoalInput.value = String(goal);
    saveState();
    renderFocusStats();
    renderWorkbenchFocus();
  }

  function exportData() {
    const payload = {
      app: "shiguang",
      version: 2,
      exportedAt: new Date().toISOString(),
      data: state
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `拾光备份-${todayKey()}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("备份已导出");
  }

  async function importData(file) {
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) {
      showToast("备份文件过大，请选择 50MB 以内的文件");
      return;
    }
    let imported;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      imported = normalizeState(parsed);
    } catch (error) {
      showToast(error.message || "备份文件读取失败，请检查文件格式");
      return;
    }

    showConfirm({
      title: "导入这份备份？",
      text: `将用备份中的 ${imported.schedules.length} 项日程、${imported.tasks.length} 个任务、${imported.focusLogs.length} 个专注记录和 ${imported.journals.length} 篇日记替换当前内容。`,
      okLabel: "导入并替换",
      onConfirm: () => {
        state = imported;
        state.demo = false;
        selectedDate = todayKey();
        setViewToDate(selectedDate);
        journalDate = todayKey();
        journalDirty = false;
        saveState();
        syncSettingsUI();
        renderAll();
        renderJournalEditor();
        dom.dataDialog.close();
        showToast("备份已导入");
      }
    });
  }

  function clearAllData() {
    showConfirm({
      title: "清空所有数据？",
      text: "日程、任务、专注记录和日记都会被删除，此操作无法撤销。建议先导出备份。",
      okLabel: "清空数据",
      onConfirm: () => {
        const settings = { ...state.settings };
        state = emptyState();
        state.settings = settings;
        selectedDate = todayKey();
        setViewToDate(selectedDate);
        journalDate = todayKey();
        journalDirty = false;
        saveState();
        syncSettingsUI();
        renderAll();
        renderJournalEditor();
        dom.dataDialog.close();
        showToast("已清空所有数据");
      }
    });
  }

  /* --------------------------------------------------------------------------
     Confirm & toast
     -------------------------------------------------------------------------- */

  function showConfirm({ title, text, okLabel = "确认删除", onConfirm }) {
    dom.confirmTitle.textContent = title;
    dom.confirmText.textContent = text;
    dom.confirmOk.textContent = okLabel;
    confirmAction = typeof onConfirm === "function" ? onConfirm : null;
    dom.confirmDialog.showModal();
  }

  function showToast(message, duration = 2800) {
    if (toastTimer) clearTimeout(toastTimer);
    dom.toastText.textContent = message;
    dom.toast.hidden = false;
    dom.toast.style.animation = "none";
    void dom.toast.offsetWidth;
    dom.toast.style.animation = "";
    toastTimer = window.setTimeout(() => {
      dom.toast.hidden = true;
      toastTimer = null;
    }, duration);
  }

  function showFormError(element, message) {
    element.textContent = message;
    element.hidden = false;
  }

  function hideFormError(element) {
    element.textContent = "";
    element.hidden = true;
  }

  function closeDialog(dialog) {
    if (dialog && dialog.open) dialog.close();
  }

  function dialogBackdropClose(dialog) {
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const inside =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
      if (!inside) closeDialog(dialog);
    });
  }

  /* --------------------------------------------------------------------------
     Events
     -------------------------------------------------------------------------- */

  function toggleScheduleDone(id) {
    const schedule = state.schedules.find((item) => item.id === id);
    if (!schedule) return;
    schedule.done = !schedule.done;
    state.demo = false;
    saveState();
    renderSchedules();
    renderCalendar();
    updateTopbar();
    updateDataStats();
    if (schedule.done) showToast("日程已完成");
  }

  function toggleTaskDone(id) {
    const task = state.tasks.find((item) => item.id === id);
    if (!task) return;
    task.done = !task.done;
    task.completedAt = task.done ? new Date().toISOString() : null;
    state.demo = false;
    saveState();
    renderTasks();
    renderFocusStats();
    updateTopbar();
    updateDataStats();
    if (task.done) showToast("任务已完成");
  }

  function newScheduleForContext() {
    openScheduleDialog(null, currentPage === "calendar" ? selectedDate : todayKey());
  }

  function bindScheduleList(list, getDate) {
    list.addEventListener("click", (event) => {
      const emptyAdd = event.target.closest("[data-empty-add]");
      if (emptyAdd) {
        openScheduleDialog(null, getDate());
        return;
      }
      const actionButton = event.target.closest("[data-action]");
      if (!actionButton) return;
      const row = actionButton.closest("[data-id]");
      if (!row) return;
      const id = row.dataset.id;
      if (actionButton.dataset.action === "toggle") {
        toggleScheduleDone(id);
      } else if (actionButton.dataset.action === "edit") {
        const schedule = state.schedules.find((item) => item.id === id);
        if (schedule) openScheduleDialog(schedule, getDate());
      }
    });
  }

  function bindEvents() {
    dom.newScheduleBtn.addEventListener("click", newScheduleForContext);
    dom.addScheduleInline.addEventListener("click", () => openScheduleDialog(null, selectedDate));
    dom.addTodayScheduleBtn.addEventListener("click", () => openScheduleDialog(null, todayKey()));
    dom.goCalendarBtn.addEventListener("click", () => setPage("calendar"));
    dom.goFocusBtn.addEventListener("click", () => setPage("focus"));
    dom.addTaskBtn.addEventListener("click", () => openTaskDialog());
    dom.prevMonth.addEventListener("click", () => shiftMonth(-1));
    dom.nextMonth.addEventListener("click", () => shiftMonth(1));
    dom.goToday.addEventListener("click", goToToday);

    for (const button of $$("[data-page-target]")) {
      button.addEventListener("click", () => setPage(button.dataset.pageTarget));
    }

    for (const button of $$("[data-task-filter]")) {
      button.addEventListener("click", () => {
        taskFilter = button.dataset.taskFilter === "done" ? "done" : "active";
        renderTasks();
      });
    }

    bindScheduleList(dom.todayScheduleList, () => todayKey());
    bindScheduleList(dom.scheduleList, () => selectedDate);

    dom.taskList.addEventListener("click", (event) => {
      const emptyAdd = event.target.closest("[data-empty-add]");
      if (emptyAdd) {
        openTaskDialog();
        return;
      }
      const actionButton = event.target.closest("[data-action]");
      if (!actionButton) return;
      const row = actionButton.closest("[data-id]");
      if (!row) return;
      const id = row.dataset.id;
      if (actionButton.dataset.action === "toggle") {
        toggleTaskDone(id);
      } else if (actionButton.dataset.action === "edit") {
        const task = state.tasks.find((item) => item.id === id);
        if (task) openTaskDialog(task);
      }
    });

    for (const button of $$("[data-scope]")) {
      button.addEventListener("click", () => setScheduleScope(button.dataset.scope));
    }
    dom.scheduleStart.addEventListener("change", () => {
      dom.scheduleEnd.min = dom.scheduleStart.value;
      if (scheduleScope === "multi" && (!dom.scheduleEnd.value || dom.scheduleEnd.value < dom.scheduleStart.value)) {
        dom.scheduleEnd.value = dom.scheduleStart.value;
      }
    });
    dom.scheduleForm.addEventListener("submit", saveSchedule);
    dom.deleteScheduleBtn.addEventListener("click", deleteSchedule);
    dom.taskForm.addEventListener("submit", saveTask);
    dom.deleteTaskBtn.addEventListener("click", deleteTask);
    dom.taskNoDue.addEventListener("change", syncTaskDueState);

    for (const button of $$("[data-focus-range]")) {
      button.addEventListener("click", () => {
        focusRange = Number(button.dataset.focusRange) || 7;
        renderFocusInsights();
      });
    }

    for (const button of $$("[data-weather]", dom.weatherOptions)) {
      button.addEventListener("click", () => {
        const weather = button.dataset.weather;
        selectedWeather = selectedWeather === weather ? "" : weather;
        updateWeatherButtons();
        markJournalDirty();
      });
    }
    dom.prevJournalDay.addEventListener("click", () => stepJournalDate(-1));
    dom.nextJournalDay.addEventListener("click", () => stepJournalDate(1));
    dom.journalTodayBtn.addEventListener("click", () => setJournalDate(todayKey()));
    dom.journalDateInput.addEventListener("change", () => setJournalDate(dom.journalDateInput.value));
    dom.saveJournalBtn.addEventListener("click", () => saveJournal({ auto: false, silent: false }));
    for (const input of [dom.journalTitleInput, dom.journalContentInput, dom.journalHappinessInput, dom.journalWorkInput]) {
      input.addEventListener("input", markJournalDirty);
    }
    dom.journalList.addEventListener("click", (event) => {
      const todayButton = event.target.closest("[data-journal-today]");
      if (todayButton) {
        setJournalDate(todayKey());
        return;
      }
      const entryButton = event.target.closest("[data-journal-date]");
      if (entryButton) setJournalDate(entryButton.dataset.journalDate);
    });

    dom.openDataBtn.addEventListener("click", openDataDialog);
    dom.demoBadge.addEventListener("click", openDataDialog);
    dom.goalMinus.addEventListener("click", () => setDailyGoal(state.settings.dailyGoal - 1));
    dom.goalPlus.addEventListener("click", () => setDailyGoal(state.settings.dailyGoal + 1));
    dom.dailyGoalInput.addEventListener("change", () => setDailyGoal(dom.dailyGoalInput.value));
    dom.dailyGoalInput.addEventListener("blur", () => setDailyGoal(dom.dailyGoalInput.value));
    dom.soundToggle.addEventListener("change", () => {
      state.settings.sound = dom.soundToggle.checked;
      saveState();
      if (state.settings.sound) {
        ensureAudioContext();
        playChime();
      }
    });
    dom.exportBtn.addEventListener("click", exportData);
    dom.importBtn.addEventListener("click", () => {
      dom.importFile.value = "";
      dom.importFile.click();
    });
    dom.importFile.addEventListener("change", () => {
      const file = dom.importFile.files && dom.importFile.files[0];
      if (file) importData(file);
    });
    dom.clearDataBtn.addEventListener("click", clearAllData);

    for (const button of $$("[data-close-dialog]")) {
      button.addEventListener("click", () => {
        const dialog = button.closest("dialog");
        closeDialog(dialog);
      });
    }

    dom.confirmCancel.addEventListener("click", () => closeDialog(dom.confirmDialog));
    dom.confirmOk.addEventListener("click", () => {
      const action = confirmAction;
      confirmAction = null;
      closeDialog(dom.confirmDialog);
      if (action) action();
    });
    dom.confirmDialog.addEventListener("close", () => {
      confirmAction = null;
    });

    for (const dialog of $$("dialog")) {
      if (dialog !== dom.confirmDialog) dialogBackdropClose(dialog);
    }

    dom.timerStartBtn.addEventListener("click", startTimer);
    dom.timerResetBtn.addEventListener("click", () => resetTimer({ toast: true }));
    dom.timerSkipBtn.addEventListener("click", skipTimerPhase);
    for (const button of $$("[data-timer-mode]")) {
      button.addEventListener("click", () => {
        const mode = button.dataset.timerMode;
        if (mode === timer.mode && !timer.running && timer.remaining === timer.total) return;
        setTimerMode(mode, { toast: timer.running });
      });
    }

    document.addEventListener("keydown", (event) => {
      if (event.code !== "Space" || currentPage !== "focus") return;
      if (event.repeat) return;
      const target = event.target;
      if (target && /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(target.tagName)) return;
      if (document.querySelector("dialog[open]")) return;
      event.preventDefault();
      if (timer.running) pauseTimer();
      else startTimer();
    });

    window.addEventListener("hashchange", () => {
      const page = location.hash.replace("#", "");
      setPage(ALLOWED_PAGES.has(page) ? page : "dashboard", false);
    });

    const persistBeforeExit = () => {
      if (currentPage === "journal" && journalDirty) {
        saveJournal({ auto: true, silent: true });
      }
      flushState();
    };
    window.addEventListener("pagehide", persistBeforeExit);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") persistBeforeExit();
    });
  }

  /* --------------------------------------------------------------------------
     Init
     -------------------------------------------------------------------------- */

  function cacheDom() {
    dom.dashboardView = $("#dashboardView");
    dom.calendarView = $("#calendarView");
    dom.focusView = $("#focusView");
    dom.journalView = $("#journalView");
    dom.bootScreen = $("#bootScreen");
    dom.newScheduleBtn = $("#newScheduleBtn");
    dom.topbarDate = $("#topbarDate");
    dom.demoBadge = $("#demoBadge");
    dom.topbarTitle = $("#topbarTitle");
    dom.topbarSummary = $("#topbarSummary");
    dom.topClockTime = $("#topClockTime");
    dom.topClockSeconds = $("#topClockSeconds");
    dom.focusClockTime = $("#focusClockTime");
    dom.focusClockSeconds = $("#focusClockSeconds");
    dom.focusClockDate = $("#focusClockDate");
    dom.weekLabel = $("#weekLabel");
    dom.dayProgressLabel = $("#dayProgressLabel");
    dom.dayProgressBar = $("#dayProgressBar");

    dom.monthLabel = $("#monthLabel");
    dom.monthSub = $("#monthSub");
    dom.calendarGrid = $("#calendarGrid");
    dom.prevMonth = $("#prevMonth");
    dom.nextMonth = $("#nextMonth");
    dom.goToday = $("#goToday");
    dom.selectedDateTitle = $("#selectedDateTitle");
    dom.selectedWeekday = $("#selectedWeekday");
    dom.selectedTodayBadge = $("#selectedTodayBadge");
    dom.scheduleSummary = $("#scheduleSummary");
    dom.scheduleProgress = $("#scheduleProgress");
    dom.scheduleList = $("#scheduleList");
    dom.addScheduleInline = $("#addScheduleInline");
    dom.todayDateTitle = $("#todayDateTitle");
    dom.todayWeekday = $("#todayWeekday");
    dom.todayScheduleSummary = $("#todayScheduleSummary");
    dom.todayScheduleProgress = $("#todayScheduleProgress");
    dom.todayScheduleList = $("#todayScheduleList");
    dom.addTodayScheduleBtn = $("#addTodayScheduleBtn");
    dom.goCalendarBtn = $("#goCalendarBtn");
    dom.workbenchTomatoes = $("#workbenchTomatoes");
    dom.workbenchFocusMinutes = $("#workbenchFocusMinutes");
    dom.workbenchRound = $("#workbenchRound");
    dom.workbenchWeekBars = $("#workbenchWeekBars");
    dom.workbenchFocusCaption = $("#workbenchFocusCaption");
    dom.goFocusBtn = $("#goFocusBtn");
    dom.calendarMonthSummary = $("#calendarMonthSummary");
    dom.calendarDayTomatoes = $("#calendarDayTomatoes");
    dom.taskList = $("#taskList");
    dom.addTaskBtn = $("#addTaskBtn");
    dom.taskCount = $("#taskCount");

    dom.statTomatoes = $("#statTomatoes");
    dom.statMinutes = $("#statMinutes");
    dom.statStreak = $("#statStreak");
    dom.goalCopy = $("#goalCopy");
    dom.goalFraction = $("#goalFraction");
    dom.goalProgressBar = $("#goalProgressBar");
    dom.weekChart = $("#weekChart");
    dom.weekTotal = $("#weekTotal");
    dom.statsTotalFocus = $("#statsTotalFocus");
    dom.statsTotalFocusUnit = $("#statsTotalFocusUnit");
    dom.statsTotalTomatoes = $("#statsTotalTomatoes");
    dom.statsAverage = $("#statsAverage");
    dom.statsGoalRate = $("#statsGoalRate");
    dom.focusTrendSummary = $("#focusTrendSummary");
    dom.trendRangeLabel = $("#trendRangeLabel");
    dom.focusTrendChart = $("#focusTrendChart");
    dom.focusTrendEmpty = $("#focusTrendEmpty");
    dom.focusDonut = $("#focusDonut");
    dom.donutTotal = $("#donutTotal");
    dom.focusDistribution = $("#focusDistribution");

    dom.timerDisplay = $("#timerDisplay");
    dom.timerModeLabel = $("#timerModeLabel");
    dom.timerNote = $("#timerNote");
    dom.timerRingProgress = $("#timerRingProgress");
    dom.timerStartBtn = $("#timerStartBtn");
    dom.timerStartLabel = $("#timerStartLabel");
    dom.timerStartIcon = $("#timerStartIcon");
    dom.timerResetBtn = $("#timerResetBtn");
    dom.timerSkipBtn = $("#timerSkipBtn");
    dom.roundLabel = $("#roundLabel");
    dom.cycleDots = $("#cycleDots");
    dom.navRunningDot = $("#navRunningDot");

    dom.scheduleDialog = $("#scheduleDialog");
    dom.scheduleForm = $("#scheduleForm");
    dom.scheduleDialogEyebrow = $("#scheduleDialogEyebrow");
    dom.scheduleDialogTitle = $("#scheduleDialogTitle");
    dom.scheduleTitle = $("#scheduleTitle");
    dom.scheduleStart = $("#scheduleStart");
    dom.scheduleEnd = $("#scheduleEnd");
    dom.scheduleDateRow = $("#scheduleDateRow");
    dom.scheduleEndField = $("#scheduleEndField");
    dom.scheduleTimeRow = $("#scheduleTimeRow");
    dom.scheduleStartTime = $("#scheduleStartTime");
    dom.scheduleEndTime = $("#scheduleEndTime");
    dom.scheduleNote = $("#scheduleNote");
    dom.scheduleError = $("#scheduleError");
    dom.deleteScheduleBtn = $("#deleteScheduleBtn");
    dom.saveScheduleBtn = $("#saveScheduleBtn");
    dom.startDateLabel = $("#startDateLabel");
    dom.scheduleScopeGroup = $("#scheduleScopeGroup");

    dom.taskDialog = $("#taskDialog");
    dom.taskForm = $("#taskForm");
    dom.taskDialogEyebrow = $("#taskDialogEyebrow");
    dom.taskDialogTitle = $("#taskDialogTitle");
    dom.taskTitle = $("#taskTitle");
    dom.taskDue = $("#taskDue");
    dom.taskNoDue = $("#taskNoDue");
    dom.taskDueHint = $("#taskDueHint");
    dom.taskError = $("#taskError");
    dom.deleteTaskBtn = $("#deleteTaskBtn");
    dom.saveTaskBtn = $("#saveTaskBtn");

    dom.dataDialog = $("#dataDialog");
    dom.dailyGoalInput = $("#dailyGoalInput");
    dom.goalMinus = $("#goalMinus");
    dom.goalPlus = $("#goalPlus");
    dom.soundToggle = $("#soundToggle");
    dom.dataStats = $("#dataStats");
    dom.demoNote = $("#demoNote");
    dom.exportBtn = $("#exportBtn");
    dom.importBtn = $("#importBtn");
    dom.importFile = $("#importFile");
    dom.clearDataBtn = $("#clearDataBtn");

    dom.journalDateTitle = $("#journalDateTitle");
    dom.journalWeekday = $("#journalWeekday");
    dom.journalTodayBadge = $("#journalTodayBadge");
    dom.journalDateInput = $("#journalDateInput");
    dom.prevJournalDay = $("#prevJournalDay");
    dom.nextJournalDay = $("#nextJournalDay");
    dom.journalTodayBtn = $("#journalTodayBtn");
    dom.weatherOptions = $("#weatherOptions");
    dom.journalTitleInput = $("#journalTitleInput");
    dom.journalContentInput = $("#journalContentInput");
    dom.journalHappinessInput = $("#journalHappinessInput");
    dom.journalWorkInput = $("#journalWorkInput");
    dom.journalSaveStatus = $("#journalSaveStatus");
    dom.saveJournalBtn = $("#saveJournalBtn");
    dom.journalList = $("#journalList");
    dom.journalTotal = $("#journalTotal");
    dom.journalStreak = $("#journalStreak");
    dom.journalMonthCount = $("#journalMonthCount");
    dom.journalCount = $("#journalCount");

    dom.confirmDialog = $("#confirmDialog");
    dom.confirmTitle = $("#confirmTitle");
    dom.confirmText = $("#confirmText");
    dom.confirmOk = $("#confirmOk");
    dom.confirmCancel = $("#confirmCancel");
    dom.toast = $("#toast");
    dom.toastText = $("#toastText");

    dom.openDataBtn = $("#openDataBtn");
    dom.focusStatsHeading = $("#focusStatsHeading");
  }

  async function init() {
    cacheDom();
    state = await loadState();
    selectedDate = todayKey();
    journalDate = todayKey();
    lastBeijingDate = selectedDate;
    setViewToDate(selectedDate);
    bindEvents();
    const initialPage = location.hash.replace("#", "");
    setPage(ALLOWED_PAGES.has(initialPage) ? initialPage : "dashboard", false);
    renderAll();
    renderJournalEditor();
    tickClock();
    updateDocumentTitle();
    window.setInterval(tickClock, 1000);
    requestPersistentStorage();

    if (dom.bootScreen) {
      dom.bootScreen.classList.add("is-hidden");
      window.setTimeout(() => dom.bootScreen.remove(), 380);
    }

    if (state.demo) {
      window.setTimeout(() => {
        showToast("已准备一组示例日程、任务和日记，可在「数据」中一键清空", 4300);
      }, 700);
    }
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    if (!/^https?:$/.test(location.protocol)) return;
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      console.warn("离线缓存注册失败，不影响正常使用。", error);
    });
  }

  function startApp() {
    init().catch((error) => {
      console.error("拾光启动失败。", error);
      if (dom.bootScreen) dom.bootScreen.classList.add("is-hidden");
      const boot = $("#bootScreen");
      if (boot) window.setTimeout(() => boot.remove(), 400);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startApp);
  } else {
    startApp();
  }
  registerServiceWorker();
})();

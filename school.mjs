/**
 * 北航统一认证 + 智学北航（SPOC）课表同步。
 *
 * 设计约束：
 * - 账号、密码只在本次函数调用内使用，不写入磁盘、不进入日志、不返回给前端。
 * - 每次同步使用独立的 Cookie 容器，不复用他人的登录态。
 * - 网络请求只发往 sso.buaa.edu.cn / spoc.buaa.edu.cn。
 */

const CAS_ENTRY = "https://spoc.buaa.edu.cn/spocnewht/cas";
const SPOC_API_BASE = "https://spoc.buaa.edu.cn/spocnewht";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

export class SchoolSyncError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "SchoolSyncError";
    this.code = code;
    this.status = status;
  }
}

/* -------------------------------------------------------------------------- */
/* Date helpers                                                               */
/* -------------------------------------------------------------------------- */

function pad(value) {
  return String(value).padStart(2, "0");
}

const beijingDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

function todayKey() {
  const parts = beijingDateFormatter.formatToParts(new Date());
  const map = {};
  for (const part of parts) if (part.type !== "literal") map[part.type] = part.value;
  return `${map.year}-${map.month}-${map.day}`;
}

function isDateKey(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function dateFromKey(key) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function keyFromDate(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function addDays(key, amount) {
  const date = dateFromKey(key);
  date.setUTCDate(date.getUTCDate() + amount);
  return keyFromDate(date);
}

function weekdayIndex(key) {
  return dateFromKey(key).getUTCDay();
}

function mondayOf(key) {
  const day = weekdayIndex(key);
  return addDays(key, -((day + 6) % 7));
}

function normalizeBuaaDate(value) {
  if (typeof value !== "string") return "";
  const text = value.trim().replace(/[./]/g, "-");
  if (isDateKey(text)) return text;
  const compact = text.replace(/[^\d]/g, "");
  if (compact.length >= 8) {
    const key = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
    if (isDateKey(key)) return key;
  }
  const monthDay = /^(\d{1,2})月(\d{1,2})日$/.exec(text);
  if (monthDay) {
    const key = `${todayKey().slice(0, 4)}-${pad(Number(monthDay[1]))}-${pad(Number(monthDay[2]))}`;
    if (isDateKey(key)) return key;
  }
  return "";
}

/* -------------------------------------------------------------------------- */
/* Cookie / HTTP helpers                                                      */
/* -------------------------------------------------------------------------- */

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  add(headers, url) {
    const rawCookies =
      typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : headers.get("set-cookie")
          ? [headers.get("set-cookie")]
          : [];
    for (const raw of rawCookies) {
      if (!raw) continue;
      const parts = raw.split(";");
      const pair = parts.shift() || "";
      const separator = pair.indexOf("=");
      if (separator < 1) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (!name) continue;
      let domain = url.hostname.toLowerCase();
      let path = "/";
      let deleteCookie = false;
      for (const attribute of parts) {
        const index = attribute.indexOf("=");
        const key = (index >= 0 ? attribute.slice(0, index) : attribute).trim().toLowerCase();
        const attrValue = index >= 0 ? attribute.slice(index + 1).trim() : "";
        if (key === "domain" && attrValue) domain = attrValue.replace(/^\./, "").toLowerCase();
        if (key === "path" && attrValue) path = attrValue;
        if (key === "max-age" && Number(attrValue) <= 0) deleteCookie = true;
      }
      const cookieKey = `${domain}|${path}|${name}`;
      if (deleteCookie) this.cookies.delete(cookieKey);
      else this.cookies.set(cookieKey, { name, value, domain, path });
    }
  }

  header(url) {
    const host = url.hostname.toLowerCase();
    const path = url.pathname || "/";
    const values = [];
    for (const cookie of this.cookies.values()) {
      const domainMatches = host === cookie.domain || host.endsWith(`.${cookie.domain}`);
      if (!domainMatches) continue;
      if (!path.startsWith(cookie.path)) continue;
      values.push(`${cookie.name}=${cookie.value}`);
    }
    return values.join("; ");
  }
}

function requestHeaders(base = {}) {
  const headers = new Headers(base);
  if (!headers.has("user-agent")) headers.set("user-agent", USER_AGENT);
  if (!headers.has("accept")) {
    headers.set("accept", "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8");
  }
  if (!headers.has("accept-language")) headers.set("accept-language", "zh-CN,zh;q=0.9,en;q=0.7");
  return headers;
}

async function requestWithJar(jar, inputUrl, options = {}) {
  let currentUrl = new URL(inputUrl);
  let method = options.method || "GET";
  let body = options.body;
  const baseHeaders = options.headers || {};
  const timeout = options.timeout ?? 20000;

  for (let redirectCount = 0; redirectCount < 12; redirectCount += 1) {
    const headers = requestHeaders(baseHeaders);
    const cookie = jar.header(currentUrl);
    if (cookie) headers.set("cookie", cookie);

    let response;
    try {
      response = await fetch(currentUrl, {
        method,
        headers,
        body: body == null || method === "GET" || method === "HEAD" ? undefined : body,
        redirect: "manual",
        signal: AbortSignal.timeout(timeout)
      });
    } catch (error) {
      const message =
        error && (error.name === "TimeoutError" || error.name === "AbortError")
          ? "连接北航统一认证超时，请检查校园网络或 VPN。"
          : "无法连接北航统一认证，请确认当前网络可以访问 sso.buaa.edu.cn。";
      throw new SchoolSyncError("NETWORK_ERROR", message, 502);
    }

    jar.add(response.headers, currentUrl);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (location) {
        const nextUrl = new URL(location, currentUrl);
        if (response.status === 303 || ([301, 302].includes(response.status) && method !== "GET" && method !== "HEAD")) {
          method = "GET";
          body = undefined;
        }
        currentUrl = nextUrl;
        continue;
      }
    }
    return { response, url: currentUrl };
  }

  throw new SchoolSyncError("REDIRECT_LOOP", "统一认证跳转次数过多，请稍后重试。", 502);
}

async function responseText(result) {
  try {
    return await result.response.text();
  } catch (error) {
    return "";
  }
}

async function responseJson(result) {
  const text = await responseText(result);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

function extractInputValue(html, name) {
  const pattern = new RegExp(
    `<input[^>]*name=["']${name}["'][^>]*value=["']([^"']*)["'][^>]*>`,
    "i"
  );
  const match = pattern.exec(html);
  return match ? match[1] : "";
}

function extractFormAction(html) {
  const formMatch = /<form[^>]*id=["']loginForm["'][^>]*action=["']([^"']+)["']/i.exec(html);
  return formMatch ? formMatch[1] : "login";
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractTokensFromUrl(url) {
  const tokenKeys = ["token", "access_token", "accessToken"];
  const refreshKeys = ["refreshToken", "refresh_token"];
  const locations = [url.searchParams];
  if (url.hash) {
    const hash = url.hash.replace(/^#/, "");
    const queryIndex = hash.indexOf("?");
    if (queryIndex >= 0) locations.push(new URLSearchParams(hash.slice(queryIndex + 1)));
    else if (hash.includes("=")) locations.push(new URLSearchParams(hash));
  }
  let token = "";
  let refreshToken = "";
  for (const params of locations) {
    if (!token) {
      for (const key of tokenKeys) {
        const value = params.get(key);
        if (value && value !== "undefined") {
          token = value;
          break;
        }
      }
    }
    if (!refreshToken) {
      for (const key of refreshKeys) {
        const value = params.get(key);
        if (value && value !== "undefined") {
          refreshToken = value;
          break;
        }
      }
    }
  }
  return { token, refreshToken };
}

function extractTokensFromObject(value) {
  const queue = [value];
  const seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const token = current.token || current.accessToken || current.access_token;
    const refreshToken = current.refreshToken || current.refresh_token || "";
    if (typeof token === "string" && token && token !== "undefined") return { token, refreshToken };
    for (const child of Object.values(current)) {
      if (child && typeof child === "object") queue.push(child);
    }
  }
  return { token: "", refreshToken: "" };
}

function looksLikeCaptcha(html) {
  if (!html) return false;
  const index = html.search(/id=["']captchaParent["']/i);
  if (index < 0) return false;
  const around = html.slice(Math.max(0, index - 220), index + 220);
  return !/display\s*:\s*none/i.test(around);
}

function looksLikeLoginPage(html) {
  return /name=["']password["']/i.test(html) && /name=["']username["']/i.test(html);
}

/* -------------------------------------------------------------------------- */
/* SPOC API                                                                   */
/* -------------------------------------------------------------------------- */

function roleCodeFor(user) {
  if (!user || typeof user !== "object") return "";
  if (typeof user.jsdm === "string" && user.jsdm) return user.jsdm;
  if (Array.isArray(user.role) && user.role.length) {
    const first = user.role.find((role) => role && role.jsdm) || user.role[0];
    if (first && typeof first.jsdm === "string") return first.jsdm;
  }
  return "";
}

function usernameFor(user, fallback) {
  if (!user || typeof user !== "object") return fallback;
  const candidates = [
    user.info && user.info.username,
    user.username,
    user.yhdm,
    user.account,
    user.user && user.user.info && user.user.info.username,
    user.user && user.user.username
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return fallback;
}

function unwrapSpocResponse(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") {
    throw new SchoolSyncError("BAD_RESPONSE", "学校服务返回了无法识别的数据。", 502);
  }
  if (payload.code != null && Number(payload.code) !== 200) {
    if ([401, 403].includes(Number(payload.code))) {
      throw new SchoolSyncError("SPOC_AUTH_FAILED", "统一认证已通过，但课表服务未授权，请稍后重试。", 502);
    }
    throw new SchoolSyncError(
      "SPOC_ERROR",
      typeof payload.msg === "string" && payload.msg ? payload.msg : "课表服务暂时不可用。",
      502
    );
  }
  if (Object.prototype.hasOwnProperty.call(payload, "content")) return payload.content;
  if (Object.prototype.hasOwnProperty.call(payload, "data")) return payload.data;
  return payload;
}

async function spocPost(jar, path, body, token, roleCode) {
  const headers = {
    accept: "application/json, text/plain, */*",
    "content-type": "application/json;charset=UTF-8",
    "x-requested-with": "XMLHttpRequest",
    Token: `Inco-${token}`
  };
  if (roleCode) headers.RoleCode = roleCode;

  const result = await requestWithJar(jar, `${SPOC_API_BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body || {})
  });
  const text = await responseText(result);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    if (result.response.status === 401 || result.response.status === 403) {
      throw new SchoolSyncError("SPOC_AUTH_FAILED", "课表服务未授权，请重新登录后再试。", 502);
    }
    throw new SchoolSyncError("BAD_RESPONSE", "课表服务返回了无法解析的内容。", 502);
  }
  if (result.response.status === 401 || result.response.status === 403) {
    throw new SchoolSyncError("SPOC_AUTH_FAILED", "课表服务未授权，请重新登录后再试。", 502);
  }
  return unwrapSpocResponse(payload);
}

async function spocGet(jar, path, params, token, roleCode) {
  const url = new URL(`${SPOC_API_BASE}${path}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const headers = {
    accept: "application/json, text/plain, */*",
    "x-requested-with": "XMLHttpRequest",
    Token: `Inco-${token}`
  };
  if (roleCode) headers.RoleCode = roleCode;

  const result = await requestWithJar(jar, url.href, { method: "GET", headers });
  const text = await responseText(result);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    if (result.response.status === 401 || result.response.status === 403) {
      throw new SchoolSyncError("SPOC_AUTH_FAILED", "课表服务未授权，请重新登录后再试。", 502);
    }
    throw new SchoolSyncError("BAD_RESPONSE", "课表服务返回了无法解析的内容。", 502);
  }
  if (result.response.status === 401 || result.response.status === 403) {
    throw new SchoolSyncError("SPOC_AUTH_FAILED", "课表服务未授权，请重新登录后再试。", 502);
  }
  return unwrapSpocResponse(payload);
}

/* -------------------------------------------------------------------------- */
/* Timetable normalization                                                    */
/* -------------------------------------------------------------------------- */

function parseTimeRange(value) {
  const text = String(value || "");
  const match = /(\d{1,2}:\d{2})\s*[-–—~至]\s*(\d{1,2}:\d{2})/.exec(text);
  if (match) return { start: match[1].padStart(5, "0"), end: match[2].padStart(5, "0") };
  return { start: "", end: "" };
}

function buildTimeSlots(jcsjList) {
  const slots = new Map();
  if (!Array.isArray(jcsjList)) return slots;
  for (const item of jcsjList) {
    if (!item || typeof item !== "object") continue;
    const periodValue = item.JC ?? item.jc ?? item.jcmc ?? item.JCMC;
    const timeValue = item.JCSJ ?? item.jcsj ?? item.JCSJMC ?? "";
    const parsed = parseTimeRange(timeValue);
    if (periodValue != null && parsed.start) {
      slots.set(String(periodValue).trim(), {
        start: parsed.start,
        end: parsed.end,
        text: String(timeValue).trim()
      });
    }
  }
  return slots;
}

function periodsFromCourse(course) {
  const raw = String(course.jc ?? course.JC ?? course.jcmc ?? course.JCMC ?? "").trim();
  const numbers = (raw.match(/\d+/g) || []).map(Number).filter((value) => Number.isFinite(value));
  if (!numbers.length) return { numbers: [], label: "" };
  const unique = [...new Set(numbers)].sort((a, b) => a - b);
  const consecutive =
    unique.every((value, index) => index === 0 || value === unique[index - 1] + 1);
  const label = consecutive && unique.length > 1
    ? `第 ${unique[0]}–${unique[unique.length - 1]} 节`
    : `第 ${unique.join("、")} 节`;
  return { numbers: unique, label };
}

function courseTime(course, timeSlots) {
  const periods = periodsFromCourse(course);
  let start = "";
  let end = "";
  if (periods.numbers.length) {
    for (const number of periods.numbers) {
      const slot = timeSlots.get(String(number));
      if (!slot) continue;
      if (!start) start = slot.start;
      end = slot.end;
    }
  }
  return {
    startTime: start,
    endTime: end,
    periods: periods.label
  };
}

function normalizeCourse(course, timeSlots) {
  if (!course || typeof course !== "object") return null;
  const name = String(course.kcmc ?? course.KCMC ?? course.courseName ?? "").trim();
  if (!name) return null;
  const time = courseTime(course, timeSlots);
  return {
    name,
    location: String(course.skdd ?? course.SKDD ?? course.location ?? "").trim(),
    teacher: String(course.jsmc ?? course.JSMC ?? course.teacher ?? "").trim(),
    periods: time.periods,
    startTime: time.startTime,
    endTime: time.endTime,
    firstPeriod: periodsFromCourse(course).numbers[0] || 99
  };
}

function courseSort(a, b) {
  if (a.firstPeriod !== b.firstPeriod) return a.firstPeriod - b.firstPeriod;
  return a.name.localeCompare(b.name, "zh-CN");
}

function chooseWeek(weeklyList) {
  if (!Array.isArray(weeklyList) || !weeklyList.length) return null;
  const today = todayKey();
  const ranked = weeklyList
    .filter((week) => week && typeof week === "object")
    .map((week) => {
      const startDate = normalizeBuaaDate(week.MINRQ ?? week.minrq);
      const endDate = normalizeBuaaDate(week.MAXRQ ?? week.maxrq);
      const weekNumber = Number(week.ZC ?? week.zc);
      const isCurrentFlag = Number(week.SFDQZ ?? week.sfdqz) === 1;
      const containsToday = startDate && endDate && startDate <= today && today <= endDate;
      return { week, startDate, endDate, weekNumber, isCurrentFlag, containsToday };
    })
    .filter((item) => Number.isFinite(item.weekNumber));

  if (!ranked.length) return null;
  const current = ranked.find((item) => item.containsToday) || ranked.find((item) => item.isCurrentFlag);
  if (current) return current;
  const dated = ranked.filter((item) => item.startDate);
  if (!dated.length) return ranked[0];
  dated.sort((a, b) => a.startDate.localeCompare(b.startDate));
  return dated.find((item) => item.startDate > today) || dated[dated.length - 1];
}

function periodLabel(startPeriod, endPeriod) {
  if (!startPeriod && !endPeriod) return "";
  if (startPeriod && endPeriod && startPeriod !== endPeriod) {
    return `第 ${startPeriod}–${endPeriod} 节`;
  }
  return `第 ${startPeriod || endPeriod} 节`;
}

function buildCalendarDays(entries, startDate) {
  const days = Array.from({ length: 7 }, (_, index) => ({
    date: addDays(startDate, index),
    weekday: index + 1,
    courses: []
  }));
  const seen = new Set();

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.lx && entry.lx !== "课程") continue;
    const date = normalizeBuaaDate(entry.rq);
    const name = String(entry.kcmc || "").trim();
    if (!name || !date) continue;
    const index = Math.round(
      (dateFromKey(date).getTime() - dateFromKey(startDate).getTime()) / 86400000
    );
    if (index < 0 || index > 6) continue;

    const time = parseTimeRange(entry.strkcsj || entry.kcsj || "");
    const startPeriod = Number(entry.kckssj) || 0;
    const endPeriod = Number(entry.kcjssj) || startPeriod;
    const location = String(entry.skdd || "").trim();
    const key = `${date}|${name}|${time.start}|${time.end}|${location}`;
    if (seen.has(key)) continue;
    seen.add(key);

    days[index].courses.push({
      name,
      location,
      teacher: String(entry.jsxm || entry.zjxm || "").trim(),
      periods: periodLabel(startPeriod, endPeriod),
      startTime: time.start,
      endTime: time.end,
      firstPeriod: startPeriod || 99
    });
  }

  for (const day of days) day.courses.sort(courseSort);
  return days;
}

function buildDays(weeksList, startDate, timeSlots) {
  const baseDate = startDate || mondayOf(todayKey());
  const coursesByDay = new Map();
  for (let index = 0; index < 7; index += 1) {
    coursesByDay.set(index, []);
  }

  if (Array.isArray(weeksList)) {
    weeksList.forEach((day, index) => {
      if (index < 0 || index > 6) return;
      const list = Array.isArray(day && day.kblist) ? day.kblist : [];
      const target = coursesByDay.get(index);
      for (const course of list) {
        const normalized = normalizeCourse(course, timeSlots);
        if (normalized) target.push(normalized);
      }
    });
  }

  return Array.from({ length: 7 }, (_, index) => ({
    date: addDays(baseDate, index),
    weekday: index + 1,
    courses: coursesByDay.get(index).sort(courseSort)
  }));
}

/* -------------------------------------------------------------------------- */
/* Public entry                                                               */
/* -------------------------------------------------------------------------- */

export async function syncBuaaTimetable({ username, password }) {
  if (!username || !password) {
    throw new SchoolSyncError("MISSING_CREDENTIALS", "请填写北航统一认证账号和密码。", 400);
  }

  const jar = new CookieJar();
  let loginPage;
  try {
    loginPage = await requestWithJar(jar, CAS_ENTRY, { timeout: 20000 });
  } catch (error) {
    if (error instanceof SchoolSyncError) throw error;
    throw new SchoolSyncError("NETWORK_ERROR", "无法连接北航统一认证，请检查网络连接。", 502);
  }

  const loginPageHtml = await responseText(loginPage);
  const ssoUrl = loginPage.url;
  if (!ssoUrl.hostname.endsWith("sso.buaa.edu.cn")) {
    throw new SchoolSyncError(
      "CAS_UNAVAILABLE",
      "统一认证入口跳转异常，请稍后再试。",
      502
    );
  }

  const execution = extractInputValue(loginPageHtml, "execution");
  if (!execution) {
    throw new SchoolSyncError(
      "CAS_UNAVAILABLE",
      "统一认证页面结构发生变化，暂时无法自动登录。",
      502
    );
  }

  const action = extractFormAction(loginPageHtml);
  const submitUrl = new URL(action, ssoUrl);
  const form = new URLSearchParams();
  form.set("username", username);
  form.set("password", password);
  form.set("type", "username_password");
  form.set("execution", execution);
  form.set("_eventId", "submit");
  form.set("submit", "LOGIN");

  const loginResult = await requestWithJar(jar, submitUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      referer: ssoUrl.href,
      origin: ssoUrl.origin
    },
    body: form.toString(),
    timeout: 25000
  });

  let tokens = extractTokensFromUrl(loginResult.url);
  let loginBodyText = "";
  let loginBodyJson = null;

  if (!tokens.token) {
    const contentType = (loginResult.response.headers.get("content-type") || "").toLowerCase();
    loginBodyText = await responseText(loginResult);
    if (contentType.includes("json") || loginBodyText.trim().startsWith("{")) {
      try {
        loginBodyJson = JSON.parse(loginBodyText);
        tokens = extractTokensFromObject(loginBodyJson);
      } catch (error) {
        loginBodyJson = null;
      }
    }
  }

  if (!tokens.token && loginBodyText) {
    const tokenMatch = /["']?(?:token|accessToken)["']?\s*[:=]\s*["']([^"']{10,})["']/i.exec(loginBodyText);
    if (tokenMatch) tokens.token = decodeHtmlEntities(tokenMatch[1]);
  }

  if (!tokens.token) {
    if (looksLikeCaptcha(loginBodyText)) {
      throw new SchoolSyncError(
        "CAPTCHA_REQUIRED",
        "北航统一认证要求输入验证码，自动同步暂时无法完成，请稍后在浏览器中登录一次再试。",
        422
      );
    }
    if (looksLikeLoginPage(loginBodyText)) {
      throw new SchoolSyncError(
        "INVALID_CREDENTIALS",
        "账号或密码不正确，或统一认证要求额外验证，请检查后重试。",
        401
      );
    }
    throw new SchoolSyncError(
      "LOGIN_INCOMPLETE",
      "统一认证未返回课表登录凭据，请检查账号状态或稍后重试。",
      502
    );
  }

  let user = null;
  try {
    user = await spocPost(jar, "/sys/casLogin", { token: tokens.token }, tokens.token, "");
  } catch (error) {
    if (error instanceof SchoolSyncError && error.code === "SPOC_AUTH_FAILED") throw error;
    // 部分帐号 casLogin 接口返回值结构不同；若课表接口仍可用则继续尝试。
    user = null;
  }

  const roleCode = roleCodeFor(user);
  const yhdm = usernameFor(user, username);
  const token = tokens.token;

  let weekly = null;
  try {
    weekly = await spocPost(jar, "/jxkb/queryScheduleWeeklyList", {}, token, roleCode);
  } catch (error) {
    // 周次信息只用于显示周号和日期；即使旧接口不可用，也继续尝试新的教学空间课表接口。
    weekly = null;
  }

  let weeklyList = [];
  if (weekly && Array.isArray(weekly.scheduleWeeklyList)) weeklyList = weekly.scheduleWeeklyList;
  else if (weekly && Array.isArray(weekly.weeks)) weeklyList = weekly.weeks;
  else if (weekly && Array.isArray(weekly)) weeklyList = weekly;

  const selectedWeek = chooseWeek(weeklyList);
  const weekNumber = selectedWeek ? selectedWeek.weekNumber : 0;
  let xn = selectedWeek ? selectedWeek.week.XN ?? selectedWeek.week.xn ?? "" : "";
  let xq = selectedWeek ? selectedWeek.week.XQ ?? selectedWeek.week.xq ?? "" : "";
  let startDate = selectedWeek ? selectedWeek.startDate : "";
  let endDate = selectedWeek ? selectedWeek.endDate : "";

  if (!isDateKey(startDate)) startDate = mondayOf(todayKey());
  if (!isDateKey(endDate) || endDate < startDate) endDate = addDays(startDate, 6);

  if (!xn || !xq) {
    try {
      const terms = await spocPost(jar, "/component/queryXnxq", {}, token, roleCode);
      const list = Array.isArray(terms) ? terms : [];
      const currentTerm = list.find((item) => String(item.sfdqxq) === "1") || list[0];
      if (currentTerm) {
        xn = currentTerm.xn || "";
        xq = currentTerm.xq || "";
      }
    } catch (error) {
      // 学期名称缺失不影响课表本身。
    }
  }

  let calendarEntries = null;
  let calendarError = null;
  try {
    calendarEntries = await spocGet(
      jar,
      "/jxkj/queryRlData",
      { zksrq: startDate, zjsrq: endDate, rllx: "1" },
      token,
      roleCode
    );
  } catch (error) {
    calendarError = error;
  }

  let days = Array.isArray(calendarEntries) ? buildCalendarDays(calendarEntries, startDate) : null;
  const hasCalendarCourses = Boolean(days && days.some((day) => day.courses.length));
  let legacyError = null;

  if (!hasCalendarCourses) {
    let slotsResponse = null;
    try {
      slotsResponse = await spocPost(jar, "/jxkb/getJcsjList", {}, token, roleCode);
    } catch (error) {
      slotsResponse = null;
    }
    const jcsjList =
      (slotsResponse && (slotsResponse.jcsjList || slotsResponse.list || slotsResponse)) || [];
    const timeSlots = buildTimeSlots(Array.isArray(jcsjList) ? jcsjList : []);

    let legacyDays = null;
    try {
      const courseResponse = await spocPost(
        jar,
        "/jxkb/getJxkbList",
        { xn, xq, zc: weekNumber, yhdm },
        token,
        roleCode
      );
      let weeksList = [];
      if (courseResponse && Array.isArray(courseResponse.weeksList)) {
        weeksList = courseResponse.weeksList;
      } else if (courseResponse && Array.isArray(courseResponse.kblist)) {
        weeksList = courseResponse.kblist;
      } else if (Array.isArray(courseResponse)) {
        weeksList = courseResponse;
      }
      legacyDays = buildDays(weeksList, startDate, timeSlots);
    } catch (error) {
      legacyError = error;
    }

    if (legacyDays && (!days || legacyDays.some((day) => day.courses.length))) {
      days = legacyDays;
    }
  }

  if (!days) {
    if (calendarError instanceof SchoolSyncError) throw calendarError;
    if (legacyError instanceof SchoolSyncError) throw legacyError;
    throw new SchoolSyncError("TIMETABLE_ERROR", "无法读取当前周课表，请稍后重试。", 502);
  }

  return {
    week: {
      xn: String(xn || ""),
      xq: String(xq || ""),
      zc: weekNumber,
      index: selectedWeek ? weekNumber + 1 : 0,
      label: selectedWeek ? `第 ${weekNumber + 1} 周` : "本周",
      term: xn ? `${xn} 学年${xq ? ` 第 ${xq} 学期` : ""}` : "",
      startDate,
      endDate
    },
    days,
    fetchedAt: new Date().toISOString(),
    source: "spoc.buaa.edu.cn"
  };
}

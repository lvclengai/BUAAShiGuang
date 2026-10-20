/* 拾光 · 专注统计图表（纯 SVG，无第三方依赖） */
(function () {
  "use strict";

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

  function renderFocusTrend(container, options) {
    if (!container) return;
    const { dayList, range, totalMinutes, formatShortDate, formatFocusDuration } = options;
    const width = 760;
    const height = 240;
    const padding = { top: 18, right: 16, bottom: 32, left: 44 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const maxValue = Math.max(30, Math.ceil(Math.max(...dayList.map((day) => day.minutes), 1) / 30) * 30);
    const bottom = padding.top + plotHeight;
    const points = dayList.map((day, index) => ({
      x: padding.left + (dayList.length === 1 ? plotWidth / 2 : (index / (dayList.length - 1)) * plotWidth),
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

    const labelStep = Math.max(1, Math.ceil(dayList.length / 7));
    const xLabels = dayList.map((day, index) => {
      if (index !== 0 && index !== dayList.length - 1 && index % labelStep !== 0) return "";
      return `<text class="chart-axis-label chart-x-label" x="${points[index].x}" y="${height - 8}" text-anchor="middle">${formatShortDate(day.key)}</text>`;
    }).join("");

    const linePath = buildSmoothPath(points);
    const areaPath = points.length
      ? `${linePath} L ${points[points.length - 1].x} ${bottom} L ${points[0].x} ${bottom} Z`
      : "";
    const dots = points
      .map((point) => `<circle class="chart-point" cx="${point.x}" cy="${point.y}" r="${range > 14 ? 2.2 : 3.2}" data-value="${point.value}" data-label="${point.label}"><title>${point.label} · ${point.value} 分钟</title></circle>`)
      .join("");

    container.innerHTML = `
      <defs>
        <linearGradient id="focusTrendFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#2f6bed" stop-opacity="0.18"></stop>
          <stop offset="100%" stop-color="#2f6bed" stop-opacity="0"></stop>
        </linearGradient>
      </defs>
      <g class="chart-grid">${gridLines}${xLabels}</g>
      ${totalMinutes > 0 ? `<path class="chart-area" d="${areaPath}"></path><path class="chart-line" d="${linePath}"></path><g class="chart-points">${dots}</g>` : ""}
    `;
    container.setAttribute(
      "aria-label",
      `近 ${range} 天专注时长趋势，总计 ${formatFocusDuration(totalMinutes)}`
    );
  }

  function buildFocusDonut(slotSummary, totalMinutes) {
    let cursor = 0;
    const segments = [];
    for (const slot of slotSummary) {
      if (slot.minutes <= 0) continue;
      const end = cursor + slot.percent;
      segments.push(`${slot.color} ${cursor.toFixed(2)}% ${end.toFixed(2)}%`);
      cursor = end;
    }
    return {
      background: segments.length
        ? `conic-gradient(${segments.join(", ")})`
        : "conic-gradient(#eef2f9 0% 100%)",
      label: totalMinutes > 0
        ? `专注时段占比：${slotSummary.map((slot) => `${slot.label}${Math.round(slot.percent)}%`).join("，")}`
        : "暂无专注记录"
    };
  }

  window.ShiguangCharts = {
    renderFocusTrend,
    buildFocusDonut
  };
})();

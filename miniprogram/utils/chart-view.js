/**
 * 把等级分曲线画到 canvas 上
 * ============================================================
 * 【为什么和 chart.js 分开】
 * chart.js 只有纯计算，能在 Node 里跑测试；
 * 本文件要调 wx.createSelectorQuery 和 canvas 2d，跑不了测试。
 * 拆开之后，容易算错的几何部分被测试完整覆盖，这里只剩下
 * 「取节点 → 按设备像素比缩放 → 调用绘图」这点胶水代码。
 *
 * 【为什么要按 devicePixelRatio 缩放】
 * canvas 的 width/height 是物理像素，CSS 尺寸是逻辑像素。
 * 不乘 dpr 的话，在高分屏上曲线会糊成一片。
 * ============================================================
 */

const { computeChartGeometry, drawLineChart } = require('./chart.js');

/**
 * 取设备像素比。取不到就退回 2——宁可略糊，也不能让曲线消失。
 * @returns {number}
 */
function getPixelRatio() {
  try {
    const info = wx.getWindowInfo();
    return info.pixelRatio || 2;
  } catch (err) {
    return 2;
  }
}

/**
 * 在页面上绘制等级分曲线。
 *
 * @param {Object} page 页面实例（this），用于限定查询范围
 * @param {Object} options
 * @param {Array<number>} options.values 按时间升序的分数序列
 * @param {number} [options.reference] 参考线（入池起点分）
 * @param {string} [options.selector='#eloChart'] canvas 选择器
 * @param {Object} [options.style] 传给 drawLineChart 的样式
 * @returns {boolean} 是否成功发起绘制
 */
function renderEloChart(page, options = {}) {
  const { values, reference, selector = '#eloChart', style } = options;

  if (!Array.isArray(values) || values.length === 0) return false;

  const query = wx.createSelectorQuery().in(page);
  query
    .select(selector)
    .fields({ node: true, size: true })
    .exec((res) => {
      const item = res && res[0];
      // 节点还没渲染出来时静默跳过。切池后紧接着重绘就会出现这种情况，
      // 此时页面会再调一次，没必要报错打扰用户。
      if (!item || !item.node) return;

      const canvas = item.node;
      const ctx = canvas.getContext('2d');
      const dpr = getPixelRatio();

      canvas.width = item.width * dpr;
      canvas.height = item.height * dpr;
      // 设置 canvas.width 会重置变换矩阵，所以 scale 放在这之后是安全的，
      // 反复重绘也不会累积放大。
      ctx.scale(dpr, dpr);

      const geometry = computeChartGeometry(values, {
        width: item.width,
        height: item.height,
        reference,
      });

      drawLineChart(ctx, geometry, style);
    });

  return true;
}

module.exports = { renderEloChart };

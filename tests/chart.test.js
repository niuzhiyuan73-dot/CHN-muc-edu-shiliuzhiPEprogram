const test = require('node:test');
const assert = require('node:assert');

const {
  MIN_RANGE,
  niceStep,
  computeChartGeometry,
  drawLineChart,
} = require('../miniprogram/utils/chart.js');

/* ============================================================
 * 假 canvas 上下文
 * ============================================================
 * 真 canvas 在 Node 里跑不起来，但我们其实不关心像素是怎么画上去的，
 * 只关心「有没有画、画在哪、画了几笔」。所以用一个只记录调用的假对象，
 * 把绘图指令录下来再断言。
 * ============================================================ */
function createFakeContext() {
  const calls = [];
  const record = (name) => (...args) => {
    calls.push({ name, args });
  };

  const ctx = {
    calls,
    byName(name) {
      return calls.filter((call) => call.name === name);
    },
    clearRect: record('clearRect'),
    beginPath: record('beginPath'),
    closePath: record('closePath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    arc: record('arc'),
    fillText: record('fillText'),
    save: record('save'),
    restore: record('restore'),
    setLineDash: record('setLineDash'),
    // stroke / fill 要顺便记下当时的样式。
    // 样式是「设置属性 → 再调用绘制」这种两步写法，只记录调用的话
    // 根本看不出某一笔是用什么颜色、多粗的线画的。
    stroke(...args) {
      calls.push({ name: 'stroke', args, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth });
    },
    fill(...args) {
      calls.push({ name: 'fill', args, fillStyle: this.fillStyle });
    },
    // 以下是被赋值而非调用的属性，留着让函数能正常写进去
    font: '',
    textAlign: '',
    textBaseline: '',
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    lineJoin: '',
    lineCap: '',
    globalAlpha: 1,
  };

  return ctx;
}

const SIZE = { width: 300, height: 120 };

/* ---------- 刻度间隔 ---------- */

test('niceStep —— 只取 1/2/5 的整十倍数', () => {
  // 刻度值要落在 1050、1100 这样的整数上，不能出现 1037.5
  assert.strictEqual(niceStep(40), 10);
  assert.strictEqual(niceStep(100), 50);
  assert.strictEqual(niceStep(200), 50);
  assert.strictEqual(niceStep(600), 200);
  assert.strictEqual(niceStep(1200), 500);
});

test('niceStep —— 跨数量级也成立', () => {
  assert.strictEqual(niceStep(4), 1);
  assert.strictEqual(niceStep(0.4, 4), 0.1);
});

test('niceStep —— 非法跨度不返回 0（否则会除零得到 Infinity）', () => {
  assert.ok(niceStep(0) > 0);
  assert.ok(niceStep(-10) > 0);
});

/* ---------- 几何计算 ---------- */

test('computeChartGeometry —— 没有数据时明确返回空', () => {
  assert.deepStrictEqual(computeChartGeometry([], SIZE), { empty: true });
  assert.deepStrictEqual(computeChartGeometry(null, SIZE), { empty: true });
  // NaN 与字符串都是无效点，等同于没有数据
  assert.strictEqual(computeChartGeometry([NaN, 'x'], SIZE).empty, true);
});

test('computeChartGeometry —— 无效点被跳过，不影响其它点', () => {
  const geometry = computeChartGeometry([1000, NaN, 1100], SIZE);
  assert.strictEqual(geometry.points.length, 2);
  assert.deepStrictEqual(
    geometry.points.map((p) => p.value),
    [1000, 1100]
  );
});

test('computeChartGeometry —— 只有一个点时画在正中，不会除零', () => {
  const geometry = computeChartGeometry([1050], SIZE);
  const [point] = geometry.points;
  assert.strictEqual(point.x, (geometry.plot.left + geometry.plot.right) / 2);
  assert.ok(Number.isFinite(point.y));
});

test('computeChartGeometry —— 首尾点贴住左右边界', () => {
  const geometry = computeChartGeometry([1000, 1050, 1100, 1150], SIZE);
  assert.strictEqual(geometry.points[0].x, geometry.plot.left);
  assert.strictEqual(geometry.points[geometry.points.length - 1].x, geometry.plot.right);
});

test('computeChartGeometry —— 分数越高，点越靠上', () => {
  // canvas 的 y 轴向下，所以数值大对应 y 小，这是最容易写反的地方
  const geometry = computeChartGeometry([1000, 1150], SIZE);
  assert.ok(geometry.points[1].y < geometry.points[0].y);
});

test('computeChartGeometry —— 所有点都落在绘图区内', () => {
  const geometry = computeChartGeometry([980, 1200, 1010, 1330, 995], SIZE);
  for (const point of geometry.points) {
    assert.ok(point.y >= geometry.plot.top, `y=${point.y} 越过了上边界`);
    assert.ok(point.y <= geometry.plot.bottom, `y=${point.y} 越过了下边界`);
    assert.ok(point.x >= geometry.plot.left);
    assert.ok(point.x <= geometry.plot.right);
  }
});

test('computeChartGeometry —— 数据几乎没变时不会画出剧烈起伏', () => {
  // 1000 涨到 1002，如果按真实范围铺满整张图，会画成一条陡峭的斜线，
  // 看着像天天在进步，其实什么都没发生
  const geometry = computeChartGeometry([1000, 1002], { ...SIZE, minRange: 60 });
  assert.ok(geometry.max - geometry.min >= 60, '纵轴跨度不该被压缩到真实波动那么小');
  assert.ok(geometry.max - geometry.min < 200, '但也不该把 60 的跨度撑得过大');
});

test('computeChartGeometry —— 参考线必须落在可视范围内', () => {
  // 参考线是入池起点分。如果它落在可视范围之外，会被画到画布外面看不见
  const geometry = computeChartGeometry([1200, 1250], { ...SIZE, reference: 1000 });
  assert.ok(geometry.min <= 1000);
  assert.ok(geometry.reference.y <= geometry.plot.bottom);
  assert.ok(geometry.reference.y >= geometry.plot.top);
});

test('computeChartGeometry —— 数据本身覆盖参考线时不额外扩范围', () => {
  const geometry = computeChartGeometry([900, 1100], { ...SIZE, reference: 1000 });
  assert.strictEqual(geometry.dataMin, 900);
  assert.strictEqual(geometry.dataMax, 1100);
  assert.ok(geometry.min <= 900);
  assert.ok(geometry.max >= 1100);
});

test('computeChartGeometry —— 刻度落在可见范围内且间距均匀', () => {
  const geometry = computeChartGeometry([1000, 1050, 1120, 1180], SIZE);
  assert.ok(geometry.grid.length >= 2, '至少要有两条刻度线');

  for (const line of geometry.grid) {
    assert.ok(line.value >= geometry.min && line.value <= geometry.max);
    assert.ok(line.y >= geometry.plot.top && line.y <= geometry.plot.bottom);
  }

  const gaps = [];
  for (let i = 1; i < geometry.grid.length; i += 1) {
    gaps.push(geometry.grid[i].value - geometry.grid[i - 1].value);
  }
  for (const gap of gaps) {
    assert.ok(Math.abs(gap - gaps[0]) < 1e-6, '刻度间距必须一致');
  }
});

test('computeChartGeometry —— 不传参考线时不产生参考线', () => {
  assert.strictEqual(computeChartGeometry([1000, 1100], SIZE).reference, null);
});

test('computeChartGeometry —— 不修改传入的数组', () => {
  const values = [1000, 1100, 1200];
  computeChartGeometry(values, SIZE);
  assert.deepStrictEqual(values, [1000, 1100, 1200]);
});

/* ---------- 绘制 ---------- */

test('drawLineChart —— 空数据不产生任何绘制调用', () => {
  const ctx = createFakeContext();
  drawLineChart(ctx, { empty: true });
  assert.strictEqual(ctx.calls.length, 0);
});

test('drawLineChart —— 缺参数时安静返回，不抛异常', () => {
  const ctx = createFakeContext();
  assert.doesNotThrow(() => drawLineChart(ctx, null));
  assert.doesNotThrow(() => drawLineChart(null, computeChartGeometry([1, 2], SIZE)));
  assert.strictEqual(ctx.calls.length, 0);
});

test('drawLineChart —— 折线的每个点都被连起来', () => {
  const ctx = createFakeContext();
  const geometry = computeChartGeometry([1000, 1030, 1010, 1060], SIZE);
  drawLineChart(ctx, geometry);

  // 每一笔的构成（g 为刻度线条数，n 为数据点数）：
  //   刻度线   g 组「moveTo + lineTo」
  //   填充区域 moveTo + (n + 1) 次 lineTo（末点多一次回到基线）
  //   折线本体 moveTo + (n - 1) 次 lineTo
  const g = geometry.grid.length;
  const n = geometry.points.length;
  assert.strictEqual(ctx.byName('moveTo').length, g + 2);
  assert.strictEqual(ctx.byName('lineTo').length, g + (n + 1) + (n - 1));
  assert.strictEqual(ctx.byName('fill').length, 2, '填充区域 + 末点实心圆');

  // 折线本体那一笔用的是主题色，可以据此从若干次 stroke 里认出它
  const polyline = ctx
    .byName('stroke')
    .find((call) => call.strokeStyle === '#b23a2e' && call.lineWidth === 2);
  assert.ok(polyline, '应当有一笔用默认主题色、2px 线宽画出的折线');
});

test('drawLineChart —— 末点被高亮，因为「我现在在哪」最值得标出来', () => {
  const ctx = createFakeContext();
  const geometry = computeChartGeometry([1000, 1030, 1010], SIZE);
  drawLineChart(ctx, geometry);

  const arcs = ctx.byName('arc');
  assert.strictEqual(arcs.length, 2, '实心圆 + 一圈淡淡的光晕');

  const last = geometry.points[geometry.points.length - 1];
  for (const arc of arcs) {
    assert.strictEqual(arc.args[0], last.x);
    assert.strictEqual(arc.args[1], last.y);
  }
});

test('drawLineChart —— 每条刻度线都标注数值', () => {
  const ctx = createFakeContext();
  const geometry = computeChartGeometry([1000, 1100, 1200], SIZE);
  drawLineChart(ctx, geometry);

  const labels = ctx.byName('fillText');
  assert.strictEqual(labels.length, geometry.grid.length);
  for (const label of labels) {
    assert.ok(Number.isFinite(Number(label.args[0])), '刻度必须是数字');
  }
});

test('drawLineChart —— 只有传了参考线才画虚线', () => {
  const withRef = createFakeContext();
  drawLineChart(withRef, computeChartGeometry([1000, 1100], { ...SIZE, reference: 1000 }));
  assert.strictEqual(withRef.byName('setLineDash').length, 1);
  assert.deepStrictEqual(withRef.byName('setLineDash')[0].args[0], [4, 4]);
  // 虚线是全局状态，画完必须恢复，否则后面的实线也会变成虚线
  assert.strictEqual(withRef.byName('restore').length, 1);

  const withoutRef = createFakeContext();
  drawLineChart(withoutRef, computeChartGeometry([1000, 1100], SIZE));
  assert.strictEqual(withoutRef.byName('setLineDash').length, 0);
});

test('drawLineChart —— 样式可由调用方覆盖', () => {
  const ctx = createFakeContext();
  const geometry = computeChartGeometry([1000, 1100], SIZE);
  drawLineChart(ctx, geometry, { lineColor: '#ff0000', lineWidth: 4 });

  const polyline = ctx.byName('stroke').find((call) => call.strokeStyle === '#ff0000');
  assert.ok(polyline, '折线要用调用方指定的颜色');
  assert.strictEqual(polyline.lineWidth, 4);
});

test('drawLineChart —— 单点数据不会画出线段但会标出这个点', () => {
  const ctx = createFakeContext();
  const geometry = computeChartGeometry([1050], SIZE);
  drawLineChart(ctx, geometry);

  // 只有刻度线会产生 lineTo，折线本身一个点连不成线
  assert.strictEqual(ctx.byName('lineTo').length, geometry.grid.length);
  assert.strictEqual(ctx.byName('arc').length, 2);
});

test('MIN_RANGE —— 最小跨度是个合理值，不会让坐标轴失真', () => {
  assert.ok(MIN_RANGE >= 30 && MIN_RANGE <= 150);
});

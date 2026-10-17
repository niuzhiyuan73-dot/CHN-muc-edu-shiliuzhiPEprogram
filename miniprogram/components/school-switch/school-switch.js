/**
 * 学校切换器（首页）
 * ============================================================
 * 与 association-switch 同一套路数：一个只读小徽章，点它弹 wx.showActionSheet，
 * 选中另一所学校后**抛出 change 事件**（`{ schoolId }`），由所在页面决定怎么用。
 *
 * 【为什么不自己读注册表】学校清单来自云端/种子的学校目录（schools 集合），
 * 不是编译期常量，组件拿不到唯一真相源，所以由页面把清单作为属性传进来。
 *
 * 【为什么只抛事件、不自己切】「当前浏览的学校」是全局会话状态，落在
 * services/school-session.js，由页面写；组件只管「用户想选哪个」。
 * ============================================================
 */

Component({
  properties: {
    /** 当前选中的学校 id */
    value: {
      type: String,
      value: '',
      observer() {
        this.refreshLabel();
      },
    },
    /** 可选学校清单：[{ schoolId, name }] */
    list: {
      type: Array,
      value: [],
      observer() {
        this.refreshLabel();
      },
    },
    /** 视觉变体：'onbrand' 用于深色品牌区（半透明白玻璃拟态）；缺省为浅底胶囊 */
    variant: {
      type: String,
      value: '',
    },
  },

  data: {
    schoolName: '',
  },

  lifetimes: {
    attached() {
      this.refreshLabel();
    },
  },

  methods: {
    /** 按 id 取学校，刷新徽章上的校名 */
    refreshLabel() {
      const list = this.data.list || [];
      const found = list.find((item) => item.schoolId === this.data.value) || list[0] || null;
      this.setData({ schoolName: found ? found.name : '' });
    },

    /** 点了徽章：弹出学校清单，选中别的学校时把 id 抛给页面 */
    onTap() {
      const list = this.data.list || [];
      if (list.length <= 1) return;
      if (typeof wx === 'undefined' || typeof wx.showActionSheet !== 'function') return;

      wx.showActionSheet({
        itemList: list.map((item) => item.name),
        success: (res) => {
          const picked = list[res.tapIndex];
          if (!picked || picked.schoolId === this.data.value) return;
          this.triggerEvent('change', { schoolId: picked.schoolId });
        },
      });
    },
  },
});

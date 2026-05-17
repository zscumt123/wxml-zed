Page({
  data: { items: [] },
  onShow() {
    this.refresh();
  },
  refresh() {
    this.setData({ items: [] });
  },
});

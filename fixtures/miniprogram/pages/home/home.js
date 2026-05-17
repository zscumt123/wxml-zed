Page({
  data: { users: [], total: 0, theme: "light", emptyReason: "" },
  onLoad() {
    this.refresh();
  },
  refresh() {
    this.setData({ users: [], total: 0 });
  },
  handleSelect(e) {
    console.log("user selected", e.detail);
  },
});

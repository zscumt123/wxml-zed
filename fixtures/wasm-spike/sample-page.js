// Sample Page for wasm JS extractor POC. ASCII only; covers both
// method-definition and function-expression-pair styles, plus one
// non-method pair (data) that the extractor must skip.

Page({
  data: {
    count: 0,
    label: "hello",
  },
  onLoad: function (options) {
    this.setData({ count: options.start ?? 0 });
  },
  onShow() {
    this.refresh();
  },
  refresh() {
    this.setData({ count: this.data.count + 1 });
  },
  handleSubmit: function (e) {
    console.log(e.detail);
  },
});

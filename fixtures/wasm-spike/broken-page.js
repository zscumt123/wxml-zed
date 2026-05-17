// Intentionally broken Page for hasError recovery regression test.
// The `onShow` method body has a trailing-dot syntax error (mid-edit
// state); tree-sitter should mark the root ERROR but still recover
// `onLoad` and `onReady` defined before/after.

Page({
  onLoad() {
    this.ready = true;
  },
  onShow() {
    this.foo.bar.
  },
  onReady() {
    // intentionally clean — recovery should reach this
  },
});

// Sample Component for wasm JS extractor POC. Covers direct
// lifecycle keys (attached, ready) and the methods block, plus an
// arrow function value and a non-function pair (properties).

Component({
  properties: {
    label: { type: String, value: "" },
  },
  attached() {
    this._wired = true;
  },
  ready: function () {
    this.triggerEvent("ready");
  },
  methods: {
    handleTap() {
      this.triggerEvent("tap");
    },
    handleSelect: function (e) {
      this.setData({ selected: e.currentTarget.dataset.id });
    },
    reset: () => {
      // arrow function as value — should still be extracted
    },
  },
});

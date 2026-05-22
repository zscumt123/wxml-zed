Component({
  behaviors: ["wx://component-export"],
  properties: {
    knownProp: { type: String, value: "" },
  },
  methods: {
    onTap() {
      this.triggerEvent("tap");
    },
  },
});

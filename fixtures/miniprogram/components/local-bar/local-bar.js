Component({
  properties: {
    locationError: { type: Boolean, value: false },
    referer: { type: String, value: "" },
  },
  methods: {
    onTap() {
      this.triggerEvent("tap");
    },
  },
});

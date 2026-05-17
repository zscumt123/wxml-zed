Component({
  properties: {
    user: { type: Object, value: {} },
  },
  methods: {
    onCardTap() {
      this.triggerEvent("select", { id: this.data.user.id });
    },
  },
});

// jsdom has no modal top layer. Unit tests exercise lifecycle and cancel events;
// browser tests verify actual background isolation and keyboard containment.
if (typeof HTMLDialogElement !== 'undefined') {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
}

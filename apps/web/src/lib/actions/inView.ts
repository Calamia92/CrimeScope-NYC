/**
 * Svelte action: invoke `onEnter` the first time the node enters the viewport,
 * then disconnect. Used to lazily mount heavy children (chart renderers, etc.).
 */
export function inView(node: HTMLElement, onEnter: () => void) {
  if (typeof IntersectionObserver === "undefined") {
    // SSR or older runtime: fire immediately.
    onEnter();
    return { destroy() {} };
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          observer.disconnect();
          onEnter();
          return;
        }
      }
    },
    { rootMargin: "200px" }
  );

  observer.observe(node);

  return {
    destroy() {
      observer.disconnect();
    }
  };
}

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * A5 (#2575) — the Dialog and Drawer primitives as rendered. (Keyboard: overlay-focus.test.ts;
 * enter/exit: presence.test.ts; motion: overlays.css.test.ts.)
 */
const nav = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  search: "status=active&drawer=abc",
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  usePathname: () => "/workers",
  useSearchParams: () => new URLSearchParams(nav.search),
}));

const { Dialog } = await import("./dialog");
const { Drawer, drawerHref, useUrlDrawer } = await import("./drawer");

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("Dialog", () => {
  it("renders nothing while closed", () => {
    expect(
      html(
        <Dialog open={false} onClose={() => {}} title="Create an admin">
          <p>Body</p>
        </Dialog>,
      ),
    ).toBe("");
  });

  const out = html(
    <Dialog
      open
      onClose={() => {}}
      title="Create an admin"
      description="Creates an active admin."
      footer={<button type="button">Save</button>}
    >
      <p>Body</p>
    </Dialog>,
  );

  it("is a modal dialog over a scrim, open state on the layer", () => {
    expect(out).toContain('<div class="overlay overlay--dialog" data-state="open">');
    expect(out).toContain('<div class="overlay__scrim" aria-hidden="true"></div>');
    expect(out).toMatch(/<div class="overlay__panel" role="dialog" aria-modal="true"/);
  });

  it("is named by its title and described by its description", () => {
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(out)?.[1];
    const describedBy = /aria-describedby="([^"]+)"/.exec(out)?.[1];
    expect(out).toContain(`<h2 class="overlay__title" id="${labelledBy}">Create an admin</h2>`);
    expect(out).toContain(
      `<p class="overlay__sub" id="${describedBy}">Creates an active admin.</p>`,
    );
  });

  it("has a labelled close button, the body and the footer", () => {
    expect(out).toContain('aria-label="Close"');
    expect(out).toContain('<div class="overlay__body"><p>Body</p></div>');
    expect(out).toContain('<div class="overlay__foot"><button type="button">Save</button></div>');
  });

  it("the panel itself can take focus (a dialog with no control still traps it)", () => {
    expect(out).toMatch(/role="dialog"[^>]*tabindex="-1"/);
  });

  it("names no description when it has none", () => {
    const bare = html(
      <Dialog open onClose={() => {}} title="T">
        x
      </Dialog>,
    );
    expect(bare).not.toContain("aria-describedby");
    expect(bare).not.toContain("overlay__foot");
  });
});

describe("Drawer", () => {
  it("is the same modal contract, anchored right", () => {
    const out = html(
      <Drawer open onClose={() => {}} title="Worker">
        <p>Detail</p>
      </Drawer>,
    );
    expect(out).toContain('<div class="overlay overlay--drawer" data-state="open">');
    expect(out).toMatch(/role="dialog" aria-modal="true"/);
    expect(out).toContain(">Worker</h2>");
  });

  it("renders nothing while closed", () => {
    expect(
      html(
        <Drawer open={false} onClose={() => {}} title="Worker">
          x
        </Drawer>,
      ),
    ).toBe("");
  });
});

describe("a drawer addressable by URL", () => {
  it("drawerHref sets and clears its param, keeping every other one", () => {
    expect(drawerHref("/workers", "status=active", "drawer", "abc")).toBe(
      "/workers?status=active&drawer=abc",
    );
    expect(drawerHref("/workers", "status=active&drawer=abc", "drawer", null)).toBe(
      "/workers?status=active",
    );
    expect(drawerHref("/workers", "drawer=abc", "drawer", null)).toBe("/workers");
    expect(drawerHref("/workers", "drawer=abc", "drawer", "xyz")).toBe("/workers?drawer=xyz");
  });

  it("useUrlDrawer is open while the param is in the URL; close replaces it away", () => {
    let api: ReturnType<typeof useUrlDrawer> | undefined;
    function Probe() {
      api = useUrlDrawer();
      return null;
    }
    html(<Probe />);
    expect(api!.isOpen).toBe(true);
    expect(api!.value).toBe("abc");
    expect(api!.href("def")).toBe("/workers?status=active&drawer=def");
    api!.close();
    expect(nav.replace).toHaveBeenCalledWith("/workers?status=active", { scroll: false });
    api!.open("def");
    expect(nav.push).toHaveBeenCalledWith("/workers?status=active&drawer=def", { scroll: false });
  });

  it("is closed when the param is absent", () => {
    nav.search = "status=active";
    let api: ReturnType<typeof useUrlDrawer> | undefined;
    function Probe() {
      api = useUrlDrawer();
      return null;
    }
    html(<Probe />);
    expect(api!.isOpen).toBe(false);
    expect(api!.value).toBeNull();
  });
});

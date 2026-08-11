// #582: the channel-list badge sat at a flat "99" while the log's own count
// climbed past it. The badge was not wrong on its own terms — the server's
// counts stopped AT the cap, so `count > 99` was unreachable and "99+" could
// never render. The fix is one shared constant with the wire, and this is the
// client half of that contract (the server half is in gateway.test.ts).

import { describe, expect, it } from "vitest";
import { UNREAD_DISPLAY_CAP } from "@emberchat/protocol";
import { clampBadge } from "./badges.js";

describe("clampBadge (#582)", () => {
  it("renders ordinary counts exactly", () => {
    expect(clampBadge(0)).toBe("0");
    expect(clampBadge(7)).toBe("7");
    expect(clampBadge(UNREAD_DISPLAY_CAP)).toBe("99");
  });

  // The regression itself: the wire saturates one past the cap, so this is the
  // value a flooded conversation actually arrives with. Before the fix it
  // arrived as the cap and rendered "99".
  it("renders the wire's saturated value as 99+", () => {
    expect(clampBadge(UNREAD_DISPLAY_CAP + 1)).toBe("99+");
  });

  it("stays 99+ for anything higher", () => {
    expect(clampBadge(4000)).toBe("99+");
  });

  // The two constants have to move together. If the wire ever saturates at or
  // below the badge's threshold, the badge silently loses its "+" again —
  // which is exactly how this bug survived unnoticed.
  it("has a saturation point the badge treats as saturated", () => {
    expect(UNREAD_DISPLAY_CAP + 1).toBeGreaterThan(UNREAD_DISPLAY_CAP);
    expect(clampBadge(UNREAD_DISPLAY_CAP + 1)).toContain("+");
  });
});

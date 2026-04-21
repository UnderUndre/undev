import { describe, it, expect } from "vitest";
import { buildTransportBuffer } from "../../server/lib/common-sh-concat.js";

describe("buildTransportBuffer (feature 005 T018)", () => {
  const commonSh = '#!/usr/bin/env bash\necho "common loaded"\n';
  const target = (sourceLine: string) =>
    `#!/usr/bin/env bash\n${sourceLine}\necho "target"\n`;

  it("injects YES=true and CI=true in the preamble", () => {
    const buf = buildTransportBuffer({
      commonSh,
      targetSh: target('source "$(dirname "$0")/common.sh"'),
      envExports: {},
    });
    expect(buf).toMatch(/^export YES=true$/m);
    expect(buf).toMatch(/^export CI=true$/m);
  });

  it("emits one export line per envExports entry, shQuoted", () => {
    const buf = buildTransportBuffer({
      commonSh,
      targetSh: target("source ./common.sh"),
      envExports: { SECRET_FOO: "bar'baz" },
    });
    expect(buf).toContain("export SECRET_FOO='bar'\\''baz'");
  });

  it("overrides source/. to no-op for common.sh", () => {
    const buf = buildTransportBuffer({
      commonSh,
      targetSh: target("source ./common.sh"),
      envExports: {},
    });
    expect(buf).toContain("source() {");
    expect(buf).toContain(".() {");
    expect(buf).toContain("*/common.sh|common.sh) return 0 ;;");
    expect(buf).toContain('builtin source "$@"');
  });

  it("strips shebang from both commonSh and targetSh", () => {
    const buf = buildTransportBuffer({
      commonSh,
      targetSh: target("source ./common.sh"),
      envExports: {},
    });
    // Neither the target's shebang nor common.sh's should be in the body.
    const withoutPreamble = buf.split("# --- begin common.sh")[1];
    expect(withoutPreamble).not.toContain("#!/usr/bin/env bash");
  });

  it("preserves source line forms unchanged (override catches them at runtime)", () => {
    const forms = [
      'source "$(dirname "$0")/common.sh"',
      '. "$(dirname "$0")/common.sh"',
      "source ./common.sh",
      'SRC="$(dirname "$0")"; source "$SRC/common.sh"',
      ". ${BASH_SOURCE%/*}/common.sh",
    ];
    for (const form of forms) {
      const buf = buildTransportBuffer({
        commonSh,
        targetSh: target(form),
        envExports: {},
      });
      expect(buf).toContain(form);
    }
  });

  it("delegates non-common.sh source to builtin source via the override", () => {
    const buf = buildTransportBuffer({
      commonSh,
      targetSh: target("source ./utils.sh"),
      envExports: {},
    });
    // The override itself calls `builtin source "$@"` in the default branch.
    expect(buf).toContain('builtin source "$@"');
  });
});

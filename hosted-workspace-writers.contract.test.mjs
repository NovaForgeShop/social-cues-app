import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const SOURCE_URL = new URL("./server.mjs", import.meta.url);
const GITIGNORE_URL = new URL("./.gitignore", import.meta.url);
const ARTIFACT_URL = new URL("./.tmp/hosted-workspace-writer-inventory.json.log", import.meta.url);
const ARTIFACT_PATH = ".tmp/hosted-workspace-writer-inventory.json.log";
const TARGET_IDENTIFIERS = new Set([
  "localSaveModel",
  "saveModel",
  "saveModelForUser",
  "mirrorWorkspaceModel"
]);
const DIRECT_PATHS = Object.freeze({
  app_state: "app_state.path",
  workspace_models: "workspace_models.path"
});
const CONTEXT_TOKEN_RADIUS = 32;

const CATEGORY_PROFILES = Object.freeze({
  DEF: Object.freeze({
    category: "definition/helper",
    hostedEffect: "definition-only",
    identityProvenance: "not-applicable",
    plannedPhase: "R4.1"
  }),
  LOCAL: Object.freeze({
    category: "local-only revisioned path",
    hostedEffect: "local-file-write-or-bootstrap",
    identityProvenance: "local-runtime",
    plannedPhase: "R4.4"
  }),
  HOSTED_FALLBACK: Object.freeze({
    category: "hosted-capable local filesystem fallback path",
    hostedEffect: "ephemeral-local-file-write-after-hosted-routing",
    identityProvenance: "generic-runtime-with-hosted-reachability",
    plannedPhase: "R4.4"
  }),
  REGISTRY_READ: Object.freeze({
    category: "shared app_state legacy registry/content path",
    hostedEffect: "shared-registry-read",
    identityProvenance: "service-role-read-context",
    plannedPhase: "R4.7"
  }),
  REGISTRY: Object.freeze({
    category: "shared app_state legacy registry/content path",
    hostedEffect: "shared-registry-or-legacy-content-write",
    identityProvenance: "server-registry-or-legacy-context",
    plannedPhase: "R4.7"
  }),
  SNAPSHOT: Object.freeze({
    category: "unconditional workspace snapshot mirror/read path",
    hostedEffect: "workspace-snapshot-read-or-unconditional-write",
    identityProvenance: "service-role-and-user-object",
    plannedPhase: "R4.4/R4.6"
  }),
  CLIENT: Object.freeze({
    category: "authenticated client model/save/recovery path",
    hostedEffect: "workspace-client-snapshot-write",
    identityProvenance: "authenticated-session",
    plannedPhase: "R4.5"
  }),
  AUTH: Object.freeze({
    category: "signup/bootstrap/session/device/auth path",
    hostedEffect: "identity-registry-and-possible-snapshot-write",
    identityProvenance: "authenticated-session-or-bootstrap",
    plannedPhase: "R4.6"
  }),
  PROVIDER: Object.freeze({
    category: "provider callback/webhook/account refresh or repair path",
    hostedEffect: "provider-state-and-possible-snapshot-write",
    identityProvenance: "provider-ingress-or-authenticated-session",
    plannedPhase: "R4.6"
  }),
  CONTENT: Object.freeze({
    category: "content/media/manual evidence path",
    hostedEffect: "workspace-content-snapshot-write",
    identityProvenance: "authenticated-session",
    plannedPhase: "R4.6"
  }),
  WORKER: Object.freeze({
    category: "background queue/worker/lease/result path",
    hostedEffect: "worker-or-queue-result-snapshot-write",
    identityProvenance: "durable-service-job-or-authenticated-session",
    plannedPhase: "R4.6"
  }),
  BILLING: Object.freeze({
    category: "billing/private normalized path",
    hostedEffect: "separate-domain-write",
    identityProvenance: "billing-service-context",
    plannedPhase: "retain-domain-boundary"
  }),
  DELETE: Object.freeze({
    category: "deletion/disconnect/retention path",
    hostedEffect: "workspace-or-registry-delete-state-write",
    identityProvenance: "authenticated-session-or-signed-provider-request",
    plannedPhase: "R4.6/R4.7"
  }),
  READ: Object.freeze({
    category: "read/status/diagnostic-only path",
    hostedEffect: "read-only-table-access",
    identityProvenance: "service-role-read-context",
    plannedPhase: "R4.4"
  })
});
const CLOSED_CATEGORIES = new Set(Object.values(CATEGORY_PROFILES).map(profile => profile.category));
const REQUIRED_CATEGORIES = Object.freeze([
  "definition/helper",
  "local-only revisioned path",
  "shared app_state legacy registry/content path",
  "unconditional workspace snapshot mirror/read path",
  "authenticated client model/save/recovery path",
  "signup/bootstrap/session/device/auth path",
  "provider callback/webhook/account refresh or repair path",
  "content/media/manual evidence path",
  "background queue/worker/lease/result path",
  "billing/private normalized path",
  "deletion/disconnect/retention path",
  "read/status/diagnostic-only path"
]);
const ALLOWED_PRIMITIVES = new Set([...TARGET_IDENTIFIERS, ...Object.values(DIRECT_PATHS)]);

const REVIEWED_ROWS = String.raw`
HW-001|localSaveModel|call|184cabddeab0d332241db846|LOCAL
HW-002|localSaveModel|definition|fb52b0663eeae3a3f14a6308|DEF
HW-003|app_state.path|path|6a77e3ab4f2b7380901a0be4|REGISTRY_READ
HW-004|app_state.path|path|b3eaf79b28a84e81c5f771f5|REGISTRY
HW-005|mirrorWorkspaceModel|definition|587b317dd8993549502667ae|DEF
HW-006|workspace_models.path|path|11222354e5ca98124d764875|SNAPSHOT
HW-007|workspace_models.path|path|00f19f2a675635be19b1cc13|READ
HW-008|workspace_models.path|path|52cf27df651b674c4bf13699|SNAPSHOT
HW-009|mirrorWorkspaceModel|call|906276284c502b164eeb64d9|SNAPSHOT
HW-010|saveModel|call|237f006cf38ed01f2723b732|REGISTRY
HW-011|saveModel|definition|a0bf4303f27c43895b61c47d|DEF
HW-012|localSaveModel|call|a3651a74f5b0f663315e7c5b|LOCAL
HW-013|localSaveModel|call|f392a9f4940815816c98302e|HOSTED_FALLBACK
HW-014|localSaveModel|call|0b72d4537a0f5cb0e45be7d7|HOSTED_FALLBACK
HW-015|saveModelForUser|definition|df418f1f863571628e6c4f29|DEF
HW-016|mirrorWorkspaceModel|call|4bc16a4ff31d772dc5c3cff9|SNAPSHOT
HW-017|saveModel|call|d3abf9882f01ab75c2740e9f|REGISTRY
HW-018|saveModel|call|ab64116d22aab69ec97eea87|REGISTRY
HW-019|mirrorWorkspaceModel|call|ff3093bdb848b0640488adbf|SNAPSHOT
HW-020|workspace_models.path|path|828cad51d261923719ad9f06|READ
HW-021|saveModelForUser|call|d93c37bac0a0528258f11fa6|WORKER
HW-022|saveModelForUser|call|ccc046f0a414e997f4f0def7|WORKER
HW-023|saveModelForUser|call|afc74353677038a0d3d430dc|WORKER
HW-024|saveModelForUser|call|eb3de037fd8b1a48a53c70b4|WORKER
HW-025|saveModelForUser|call|40c5c770cc0898f9fda7ef92|WORKER
HW-026|saveModelForUser|call|52db925c194146e82bace518|WORKER
HW-027|saveModelForUser|call|bac277bba48718a55455400c|PROVIDER
HW-028|saveModelForUser|call|8986842e4d91194d06d7bc82|PROVIDER
HW-029|saveModelForUser|call|6fc22946a84859bbfbc73795|PROVIDER
HW-030|saveModel|call|af54bcacd296682376b81a3d|PROVIDER
HW-031|saveModelForUser|call|4147e80075dbb8148507a221|PROVIDER
HW-032|saveModelForUser|call|10fb38ac0ebbc86c710eca7f|PROVIDER
HW-033|saveModelForUser|call|74a4637eb4dcc0548b135367|PROVIDER
HW-034|saveModelForUser|call|0d817a259fef59b08500c614|PROVIDER
HW-035|saveModelForUser|call|53e131d904100613b346eb22|PROVIDER
HW-036|saveModelForUser|call|0faf82a66ea3ca39a24cb6ac|PROVIDER
HW-037|saveModelForUser|call|e32e6723bb8490980fab6e14|PROVIDER
HW-038|saveModelForUser|call|914a15d5cd11dfe3373f4a43|PROVIDER
HW-039|saveModelForUser|call|4c9d9b1f7d843d20a38a1c92|PROVIDER
HW-040|saveModelForUser|call|2a9b23b5b286214a197d65d7|PROVIDER
HW-041|saveModelForUser|call|9fe3cf4927b082b76b3b062e|PROVIDER
HW-042|saveModelForUser|call|dffd3a4ed55fd82984ba4024|PROVIDER
HW-043|saveModelForUser|call|6a6dcf9b0347a485321a49bc|PROVIDER
HW-044|saveModelForUser|call|5cf8d4db4ae367cbbef4e0b1|PROVIDER
HW-045|saveModelForUser|call|3270a7aaa33f3f218eaaa248|PROVIDER
HW-046|saveModelForUser|call|a7ded36e2c90c103105c67fe|PROVIDER
HW-047|saveModelForUser|call|a0acb78822fe8be2e8e93e26|PROVIDER
HW-048|saveModelForUser|call|53946c1737c05541b4b31947|PROVIDER
HW-049|saveModelForUser|call|8f506fcbfe78d519dd129639|PROVIDER
HW-050|saveModel|call|78535cfe548bb291c5458e85|PROVIDER
HW-051|saveModelForUser|call|cf83d4a102c0b05fa376ed84|PROVIDER
HW-052|saveModel|call|420b712c820ef1e6fdd3d381|PROVIDER
HW-053|saveModelForUser|call|8d7e6214cfeb2005f5e15257|PROVIDER
HW-054|saveModelForUser|call|414e2376085415e3bbe91c3a|PROVIDER
HW-055|saveModelForUser|call|6f5ddb9afd774bc8d66f9be0|PROVIDER
HW-056|saveModel|call|731b347fa3673eb4aa59482f|PROVIDER
HW-057|saveModel|call|055076bda50688b3bb88a16a|PROVIDER
HW-058|saveModel|call|8b5404d4259ae01b7ba6e058|PROVIDER
HW-059|saveModel|call|0aba8a64c8ea3bef90404ce6|AUTH
HW-060|saveModelForUser|call|ee802ce3933bb8f996425dff|PROVIDER
HW-061|saveModelForUser|call|f3d798752c0a2bee66f51111|PROVIDER
HW-062|saveModel|call|7588f689d17fd34e2321f052|PROVIDER
HW-063|saveModel|call|254cc223b59af75a3d313d1b|DELETE
HW-064|saveModel|call|bfc206116fcabf88458d95c0|DELETE
HW-065|saveModel|call|5aafc06e9ecdc40d73bf3ed3|PROVIDER
HW-066|saveModel|call|22abe59e8b6d213eed1f0973|PROVIDER
HW-067|saveModel|call|a56fc9e090bdfb441b4ed17c|PROVIDER
HW-068|saveModel|call|e336cbcc9135544ffbd1a258|PROVIDER
HW-069|saveModel|call|b58b20c1a1bc29cdbca93ac9|PROVIDER
HW-070|saveModel|call|4ca013306b1e299c4f8b1304|PROVIDER
HW-071|saveModelForUser|call|8ff017baa316fbd2e6f7b072|PROVIDER
HW-072|mirrorWorkspaceModel|call|1f7e531cc9b4e3bf8b5f2459|PROVIDER
HW-073|saveModel|call|8c67cea749569cf3f3a38967|PROVIDER
HW-074|saveModel|call|8798e64b0c2499c0ca183fcd|PROVIDER
HW-075|saveModel|call|a11a587b0b05c68c96b4c75d|PROVIDER
HW-076|saveModel|call|54d5e40d76538654ad38d81c|PROVIDER
HW-077|saveModelForUser|call|fbdf9db8c0ed8757d8e9e803|PROVIDER
HW-078|mirrorWorkspaceModel|call|0ac751b6931351e39af712b8|PROVIDER
HW-079|saveModel|call|b758ba56a2ad6b43a8e70c97|PROVIDER
HW-080|saveModel|call|900e8c2b1dce6b54b11961f2|PROVIDER
HW-081|saveModel|call|2c781f8a81a263092bd7b625|PROVIDER
HW-082|saveModelForUser|call|a89b33dc33712f9aed204668|PROVIDER
HW-083|saveModel|call|907cba4dfb21ded5f0e13873|PROVIDER
HW-084|saveModel|call|3ad74b70fab5e7d9a934a256|PROVIDER
HW-085|saveModel|call|be11ebb6009a0249f04cccf7|PROVIDER
HW-086|saveModelForUser|call|1f410edf7ac9ad9d423c4408|PROVIDER
HW-087|saveModel|call|02c473a880496f6521308302|PROVIDER
HW-088|saveModel|call|755bed2ceba085f4b12ec98f|PROVIDER
HW-089|saveModel|call|b71e43cb02d943ce116f20c5|PROVIDER
HW-090|saveModelForUser|call|c12032d15d83de6b282c5e26|PROVIDER
HW-091|mirrorWorkspaceModel|call|24c0ed5e1fde2b9a5ccd0727|PROVIDER
HW-092|saveModel|call|d84923ff4a89e2b4ecbc4381|PROVIDER
HW-093|saveModel|call|10cc267f2c65088822f418cb|PROVIDER
HW-094|saveModel|call|5962b98c337a089f4eaba562|PROVIDER
HW-095|saveModel|call|d4274528db1a2374a51dbe34|PROVIDER
HW-096|saveModelForUser|call|3f291aefc74c2daab7b79230|PROVIDER
HW-097|mirrorWorkspaceModel|call|39d76833265c94e0d19388a2|PROVIDER
HW-098|saveModel|call|c8e068ea4cd7f376dfda4254|PROVIDER
HW-099|saveModel|call|f42eb613810d35f54eec3105|PROVIDER
HW-100|saveModel|call|b675b470e457b9ee29e10386|PROVIDER
HW-101|saveModel|call|4e649cc339e88d9e6909e636|PROVIDER
HW-102|saveModelForUser|call|083fa30a00993b2b8a7c6282|PROVIDER
HW-103|mirrorWorkspaceModel|call|c47dbefd803469f20585700c|PROVIDER
HW-104|saveModel|call|948d61bbf1abe51428918b43|PROVIDER
HW-105|saveModel|call|97b2d6d482ae663a8998a9aa|PROVIDER
HW-106|saveModel|call|9f2ec0a7db242da02ce8bc10|PROVIDER
HW-107|saveModelForUser|call|d9033a953fd19457f065a90e|PROVIDER
HW-108|saveModel|call|9ef0488155c268d0a964ed95|PROVIDER
HW-109|saveModel|call|88edde33771a5db713e048af|PROVIDER
HW-110|saveModel|call|00992e0ccad30092a8fccbab|PROVIDER
HW-111|saveModelForUser|call|0642734207a67fce4ecb0868|PROVIDER
HW-112|saveModel|call|f8433e0edb465ceab46ccbbe|PROVIDER
HW-113|saveModel|call|e5b1abfe294b212e6c6e2e58|PROVIDER
HW-114|saveModel|call|3a57900fe8c756197ce80fd5|PROVIDER
HW-115|saveModelForUser|call|3159fb419fb1e8316282bfd3|PROVIDER
HW-116|saveModel|call|a0ae6fcbead5a4991ad9abcf|PROVIDER
HW-117|saveModel|call|d57e4c5492b78576f67a5c7b|PROVIDER
HW-118|saveModel|call|8cd154079cfd9d5e0b6de570|PROVIDER
HW-119|saveModelForUser|call|bcfc89cada7af3801d7ad80c|PROVIDER
HW-120|mirrorWorkspaceModel|call|2d25565788e40ad3cbf674bd|PROVIDER
HW-121|saveModel|call|4261dddfdafa3cd941f5f889|PROVIDER
HW-122|saveModel|call|24ea28e8e0939e013544aae3|PROVIDER
HW-123|saveModel|call|b531091d6777d72f7aae9572|PROVIDER
HW-124|saveModel|call|980c28fc58955b1a962428b0|PROVIDER
HW-125|saveModelForUser|call|76541f4b6c7bea4ccf98f491|PROVIDER
HW-126|saveModel|call|1c8fde0ec928c5d9d73136dc|PROVIDER
HW-127|saveModel|call|42be89158945e1cf64d69daf|PROVIDER
HW-128|saveModelForUser|call|491556c6024c9b5ae452c3e4|PROVIDER
HW-129|saveModelForUser|call|36ed8f50291d8d7a3c3f2a74|CONTENT
HW-130|saveModelForUser|call|21c2eb91e0854886ad5108cc|CONTENT
HW-131|saveModelForUser|call|4cc643cc5f68cd2ce243204e|PROVIDER
HW-132|saveModelForUser|call|ff32c9dfdda891994824ab23|CLIENT
HW-133|saveModelForUser|call|b68209666d76b6cc9771daeb|CLIENT
HW-134|saveModel|call|75b6bc10b9681efe0797f8ee|AUTH
HW-135|saveModelForUser|call|f9fd01cdd0c7471d1463b383|AUTH
HW-136|saveModel|call|cd51f6d6452edbf305ffa30b|AUTH
HW-137|saveModel|call|3ad5b22c263ca8056b03c8b1|AUTH
HW-138|saveModelForUser|call|eb0e1ba0e8dc0270b3e1d60b|AUTH
HW-139|saveModel|call|44a919aac657c9ef9f76e570|AUTH
HW-140|saveModelForUser|call|19727920b8539da271ccb32d|AUTH
HW-141|saveModel|call|9c96be06e8598795c7e3b42d|AUTH
HW-142|saveModelForUser|call|190fc0a3c23b085277552e20|AUTH
HW-143|saveModel|call|6cce21776785099927a62f2b|AUTH
HW-144|saveModel|call|b33e2d6b4854b0ff5cba6aa5|AUTH
HW-145|saveModel|call|442efaaeb29425598fb1e53e|AUTH
HW-146|saveModel|call|5695ff753588baaf0b8da887|AUTH
HW-147|saveModel|call|69ff7ab32f0063d518310f44|AUTH
HW-148|saveModel|call|a6a051b3b4ff9c4f2c3cba0b|AUTH
HW-149|saveModel|call|92200b170f6654b14f4f5232|AUTH
HW-150|saveModel|call|120738d9a3b11ff2c9b7140e|AUTH
HW-151|saveModelForUser|call|60e1632b13c8aba705bfce53|CONTENT
HW-152|saveModelForUser|call|cd60836dc2672a6a8aa84915|CONTENT
HW-153|saveModelForUser|call|1ed8af32adb7b02a965e1548|WORKER
HW-154|saveModelForUser|call|c985617c2fd19bd81d42475e|WORKER
HW-155|saveModelForUser|call|0df0e52eec9e3a1d1b7b4b37|WORKER
HW-156|saveModelForUser|call|f9424b58ce6de5803e3f8044|CONTENT
HW-157|saveModelForUser|call|063dd9c936d30faa95e125c0|CONTENT
HW-158|saveModelForUser|call|bdfa06aee5281e9ee3b0a1bc|CONTENT
HW-159|saveModelForUser|call|f92cfaf71bfa3c1e6a8b4f32|WORKER
HW-160|saveModelForUser|call|b94aa2d621200f467afc5d26|PROVIDER
HW-161|saveModelForUser|call|c55087bdb88af3d6214927a7|PROVIDER
HW-162|saveModelForUser|call|2394089f37fa510e41ae59b1|PROVIDER
HW-163|saveModelForUser|call|b31af742c15e36f13fcf79ce|PROVIDER
HW-164|saveModelForUser|call|08ccd6d970c05ddb3b4a1095|PROVIDER
HW-165|saveModelForUser|call|3ad156c797b5b34e3a5500e2|PROVIDER
HW-166|saveModelForUser|call|fbeabbf5dee56be6e272767b|PROVIDER
HW-167|saveModelForUser|call|e587842638e8470fa166fe81|PROVIDER
HW-168|saveModelForUser|call|5076949a6ba1f47e79aefc75|PROVIDER
HW-169|saveModelForUser|call|26536c84cc99bac466f169b7|CONTENT
HW-170|saveModelForUser|call|8a14bf3cecc7113a34594fd1|PROVIDER
HW-171|saveModelForUser|call|4497e164a367caf0d378b0c9|PROVIDER
HW-172|saveModelForUser|call|7f0e6b34e89e818b58276991|PROVIDER
HW-173|saveModelForUser|call|d96a90e4a01ee87e98fcbffc|PROVIDER
HW-174|saveModelForUser|call|d4aa60f5435dbe7d9fe97423|PROVIDER
HW-175|saveModelForUser|call|edb45f7102b6cb9740aea20c|PROVIDER
HW-176|saveModelForUser|call|2208e63a7eced0253d923860|PROVIDER
HW-177|saveModelForUser|call|cef3b6b8a21a9fcdb378b3cb|PROVIDER
HW-178|saveModelForUser|call|7a7c56fba00d3f70da281615|PROVIDER
HW-179|saveModel|call|780165520bf1d60d7f3d5e33|PROVIDER
HW-180|saveModel|call|7407896144090a0519f0a3aa|PROVIDER
HW-181|saveModel|call|d9fe02a168f507f1f9aabfa6|PROVIDER
HW-182|saveModelForUser|call|3ffde290b2d15fdb21dbdf17|PROVIDER
HW-183|saveModelForUser|call|d7c28e61d6fbf3f2938b3d80|PROVIDER
HW-184|saveModelForUser|call|101576209af514fb2583c8f7|PROVIDER
HW-185|saveModelForUser|call|a764d24d86ad160f157f0ea8|PROVIDER
HW-186|saveModelForUser|call|da24f44c2759dda0210b4919|PROVIDER
HW-187|saveModelForUser|call|37e182577b8e100fcf8107ba|PROVIDER
HW-188|saveModelForUser|call|5dc228943cda931a478b36e9|PROVIDER
HW-189|saveModelForUser|call|0fdadb01001035d5b92d427a|CONTENT
HW-190|saveModelForUser|call|a9c88e6f0d5cfe7b9cef449b|PROVIDER
HW-191|saveModelForUser|call|83d4a139e9dbb7bd11f77024|PROVIDER
HW-192|saveModelForUser|call|ddcfdbbdfeb1fee8dfbf1599|PROVIDER
HW-193|saveModelForUser|call|2ce334909d530ab93ee7a202|PROVIDER
HW-194|saveModelForUser|call|429cf8f5ea9aaba02e18e792|CONTENT
HW-195|saveModelForUser|call|01e408b3a4c08b79fcc04c07|PROVIDER
HW-196|saveModelForUser|call|3307fb43eb8947c6d0301c35|PROVIDER
HW-197|saveModelForUser|call|d0a2c0bff9ec47ae575b5868|PROVIDER
HW-198|saveModelForUser|call|8588272d269372ee849c85eb|PROVIDER
HW-199|saveModelForUser|call|a4bdf8ee40f0ff7666b58274|PROVIDER
HW-200|saveModelForUser|call|17992b81a60239262f18322d|PROVIDER
HW-201|saveModelForUser|call|b1af808a277de61733d9d3f2|PROVIDER
HW-202|saveModelForUser|call|604738f5131ce2f2a78ab4f6|PROVIDER
HW-203|saveModelForUser|call|a26ced626bdeed33b8af080c|PROVIDER
HW-204|saveModelForUser|call|9a3057f60652fa7bc9915abe|PROVIDER
HW-205|saveModelForUser|call|7986a12d3fa25c8d33ac7355|DELETE
HW-206|saveModelForUser|call|7c8fa6361491de19a39e1dc1|CONTENT
`;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function tokenizeJavaScript(input) {
  const source = input.replace(/\r\n?/g, "\n");
  const tokens = [];
  let index = 0;
  let line = 1;
  let column = 1;

  function advance() {
    const value = source[index++];
    if (value === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
    return value;
  }

  function push(type, value, start, startLine, startColumn) {
    tokens.push({ type, value, start, end: index, line: startLine, column: startColumn });
  }

  function skipLineComment() {
    advance();
    advance();
    while (index < source.length && source[index] !== "\n") advance();
  }

  function skipBlockComment() {
    const startLine = line;
    advance();
    advance();
    while (index < source.length) {
      if (source[index] === "*" && source[index + 1] === "/") {
        advance();
        advance();
        return;
      }
      advance();
    }
    throw new Error(`unterminated block comment starting on line ${startLine}`);
  }

  function scanQuotedString(quote) {
    const start = index;
    const startLine = line;
    const startColumn = column;
    advance();
    let value = "";
    while (index < source.length) {
      const character = advance();
      if (character === "\\") {
        value += character;
        if (index < source.length) value += advance();
        continue;
      }
      if (character === quote) {
        push("string", value, start, startLine, startColumn);
        return;
      }
      value += character;
    }
    throw new Error(`unterminated string starting on line ${startLine}`);
  }

  function regexCanStartAfter(previous) {
    if (!previous) return true;
    if (["return", "throw", "case", "delete", "void", "typeof", "instanceof", "in", "of", "yield", "await", "else", "do"].includes(previous.value)) return true;
    if (["identifier", "number", "string", "regex"].includes(previous.type)) return false;
    return ![")", "]", "}", "++", "--"].includes(previous.value);
  }

  function scanRegex() {
    const start = index;
    const startLine = line;
    const startColumn = column;
    let value = advance();
    let inClass = false;
    while (index < source.length) {
      const character = advance();
      value += character;
      if (character === "\\") {
        if (index < source.length) value += advance();
        continue;
      }
      if (character === "[") inClass = true;
      if (character === "]") inClass = false;
      if (character === "/" && !inClass) {
        while (/[A-Za-z]/.test(source[index] || "")) value += advance();
        push("regex", value, start, startLine, startColumn);
        return;
      }
      if (character === "\n") throw new Error(`unterminated regular expression starting on line ${startLine}`);
    }
    throw new Error(`unterminated regular expression starting on line ${startLine}`);
  }

  function scanTemplate() {
    advance();
    let segmentStart = index;
    let segmentLine = line;
    let segmentColumn = column;
    let value = "";
    while (index < source.length) {
      const character = advance();
      if (character === "\\") {
        value += character;
        if (index < source.length) value += advance();
        continue;
      }
      if (character === "`") {
        if (value) push("string", value, segmentStart, segmentLine, segmentColumn);
        return;
      }
      if (character === "$" && source[index] === "{") {
        if (value) push("string", value, segmentStart, segmentLine, segmentColumn);
        const markerStart = index - 1;
        const markerLine = line;
        const markerColumn = column - 1;
        advance();
        push("punctuator", "${", markerStart, markerLine, markerColumn);
        scanCode(true);
        segmentStart = index;
        segmentLine = line;
        segmentColumn = column;
        value = "";
        continue;
      }
      value += character;
    }
    throw new Error(`unterminated template starting on line ${segmentLine}`);
  }

  function scanCode(stopAtInterpolationEnd = false) {
    let interpolationBraceDepth = 0;
    const punctuators = ["===", "!==", ">>>", "**=", "&&=", "||=", "??=", "...", "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "**", "<<", ">>"];
    while (index < source.length) {
      const character = source[index];
      if (/\s/.test(character)) {
        advance();
        continue;
      }
      if (character === "/" && source[index + 1] === "/") {
        skipLineComment();
        continue;
      }
      if (character === "/" && source[index + 1] === "*") {
        skipBlockComment();
        continue;
      }
      if (stopAtInterpolationEnd && character === "}" && interpolationBraceDepth === 0) {
        const start = index;
        const startLine = line;
        const startColumn = column;
        advance();
        push("punctuator", "}", start, startLine, startColumn);
        return;
      }
      if (character === "'" || character === '"') {
        scanQuotedString(character);
        continue;
      }
      if (character === "`") {
        scanTemplate();
        continue;
      }
      if (character === "/" && regexCanStartAfter(tokens.at(-1))) {
        scanRegex();
        continue;
      }
      const start = index;
      const startLine = line;
      const startColumn = column;
      if (/[A-Za-z_$]/.test(character)) {
        let value = advance();
        while (/[A-Za-z0-9_$]/.test(source[index] || "")) value += advance();
        push("identifier", value, start, startLine, startColumn);
        continue;
      }
      if (/[0-9]/.test(character)) {
        let value = advance();
        while (/[A-Za-z0-9_.]/.test(source[index] || "")) value += advance();
        push("number", value, start, startLine, startColumn);
        continue;
      }
      const punctuator = punctuators.find(candidate => source.startsWith(candidate, index)) || character;
      for (let offset = 0; offset < punctuator.length; offset += 1) advance();
      push("punctuator", punctuator, start, startLine, startColumn);
      if (stopAtInterpolationEnd && punctuator === "{") interpolationBraceDepth += 1;
      if (stopAtInterpolationEnd && punctuator === "}") interpolationBraceDepth -= 1;
    }
    if (stopAtInterpolationEnd) throw new Error("unterminated template interpolation");
  }

  scanCode(false);
  return { source, tokens };
}

function safeTokenFingerprint(token) {
  if (token.type === "string" || token.type === "regex") return `${token.type}:${sha256(token.value)}`;
  if (token.type === "number") return "number:#";
  return `${token.type}:${token.value}`;
}

function structuralDigest(tokens, tokenIndex, primitive, kind, withinToken = 0) {
  const from = Math.max(0, tokenIndex - CONTEXT_TOKEN_RADIUS);
  const to = Math.min(tokens.length, tokenIndex + CONTEXT_TOKEN_RADIUS + 1);
  const context = tokens.slice(from, to).map(safeTokenFingerprint).join("|");
  return sha256(`${primitive}|${kind}|${withinToken}|${context}`);
}

function discoverWriterSites(input) {
  const { tokens } = tokenizeJavaScript(input);
  const sites = [];
  for (const [tokenIndex, token] of tokens.entries()) {
    if (token.type === "identifier" && TARGET_IDENTIFIERS.has(token.value)) {
      const previous = tokens[tokenIndex - 1];
      const beforePrevious = tokens[tokenIndex - 2];
      const next = tokens[tokenIndex + 1];
      const definition = previous?.value === "function" || (previous?.value === "*" && beforePrevious?.value === "function");
      const kind = definition ? "definition" : next?.value === "(" ? "call" : "reference";
      const digest = structuralDigest(tokens, tokenIndex, token.value, kind);
      sites.push({ primitive: token.value, kind, line: token.line, start: token.start, digest, anchor: `sha256:${digest.slice(0, 24)}` });
    }
    if (token.type !== "string") continue;
    for (const [table, primitive] of Object.entries(DIRECT_PATHS)) {
      const expression = new RegExp(`/${table}(?=[/?]|$)`, "g");
      let match;
      let withinToken = 0;
      while ((match = expression.exec(token.value)) !== null) {
        const lineOffset = token.value.slice(0, match.index).split("\n").length - 1;
        const digest = structuralDigest(tokens, tokenIndex, primitive, "path", withinToken);
        sites.push({ primitive, kind: "path", line: token.line + lineOffset, start: token.start + match.index, digest, anchor: `sha256:${digest.slice(0, 24)}` });
        withinToken += 1;
      }
    }
  }
  return sites.sort((left, right) => left.start - right.start || left.primitive.localeCompare(right.primitive));
}

function parseReviewedManifest() {
  const rows = REVIEWED_ROWS.split("\n").map(row => row.trim()).filter(Boolean);
  return rows.map((row, index) => {
    const fields = row.split("|");
    assert.equal(fields.length, 5, `manifest row ${index + 1} must have five fields`);
    const [id, primitive, kind, digestPrefix, profileName] = fields;
    assert.equal(id, `HW-${String(index + 1).padStart(3, "0")}`, `manifest identity ${id} is out of sequence`);
    assert.ok(ALLOWED_PRIMITIVES.has(primitive), `unknown primitive ${primitive}`);
    assert.ok(["call", "definition", "reference", "path"].includes(kind), `unknown site kind ${kind}`);
    assert.equal(Object.values(DIRECT_PATHS).includes(primitive), kind === "path", `path kind mismatch for ${id}`);
    assert.match(digestPrefix, /^[a-f0-9]{24}$/);
    assert.ok(CATEGORY_PROFILES[profileName], `unknown profile ${profileName}`);
    return { id, primitive, kind, digestPrefix, profileName, ...CATEGORY_PROFILES[profileName] };
  });
}

function hasSubsequence(values, expected) {
  for (let index = 0; index <= values.length - expected.length; index += 1) {
    if (expected.every((value, offset) => values[index + offset] === value)) return true;
  }
  return false;
}

function assertReleaseHoldsAndInertAdapter(source) {
  const { tokens } = tokenizeJavaScript(source);
  const values = tokens.map(token => token.value);
  assert.equal(values.filter(value => value === "hostedWorkspacePersistence").length, 0, "server.mjs initializes or references hosted workspace persistence");
  assert.equal(values.filter(value => value === "createHostedWorkspacePersistence").length, 0, "server.mjs creates hosted workspace persistence");
  assert.equal(tokens.filter(token => token.type === "string" && token.value.includes("hosted-workspace-persistence.mjs")).length, 0, "server.mjs imports the inert hosted workspace adapter");

  const gateIndex = values.indexOf("releaseReadinessGates");
  assert.ok(gateIndex >= 0, "release readiness gates are missing");
  const gateValues = values.slice(gateIndex, gateIndex + 48);
  assert.ok(hasSubsequence(gateValues, ["hostedPersistence", ":", "Object", ".", "freeze", "(", "{", "review", ":", "R4", ",", "status", ":", "HOLD", "}", ")"]), "R4 hosted persistence is not held");
  assert.ok(hasSubsequence(gateValues, ["externalUserContent", ":", "HOLD"]), "external user content is not held");
}

function verifyAgainstManifest(source, manifest) {
  assertReleaseHoldsAndInertAdapter(source);
  const sites = discoverWriterSites(source);
  const manifestIds = manifest.map(entry => entry.id);
  assert.equal(new Set(manifestIds).size, manifest.length, "duplicate manifest identity");
  const manifestKeys = manifest.map(entry => `${entry.primitive}|${entry.kind}|${entry.digestPrefix}`);
  assert.equal(new Set(manifestKeys).size, manifest.length, "duplicate manifest structural anchor");
  const discoveredKeys = sites.map(site => `${site.primitive}|${site.kind}|${site.digest.slice(0, 24)}`);
  assert.equal(new Set(discoveredKeys).size, sites.length, "duplicate discovery structural anchor");
  const sourceLineCount = source.split("\n").length;

  const manifestByKey = new Map(manifest.map(entry => [`${entry.primitive}|${entry.kind}|${entry.digestPrefix}`, entry]));
  const matchedIds = new Set();
  const inventory = sites.map(site => {
    assert.ok(Number.isSafeInteger(site.line) && site.line > 0 && site.line <= sourceLineCount, "invalid discovery line");
    assert.match(site.anchor, /^sha256:[a-f0-9]{24}$/);
    const key = `${site.primitive}|${site.kind}|${site.digest.slice(0, 24)}`;
    const entry = manifestByKey.get(key);
    assert.ok(entry, `unreviewed writer site: ${site.primitive} ${site.kind} line ${site.line} ${site.anchor}`);
    assert.ok(!matchedIds.has(entry.id), `manifest entry matched twice: ${entry.id}`);
    matchedIds.add(entry.id);
    assert.ok(CLOSED_CATEGORIES.has(entry.category), `unclassified category for ${entry.id}`);
    return {
      id: entry.id,
      primitive: site.primitive,
      kind: site.kind,
      line: site.line,
      anchor: site.anchor,
      category: entry.category,
      hostedEffect: entry.hostedEffect,
      identityProvenance: entry.identityProvenance,
      plannedPhase: entry.plannedPhase
    };
  });
  const missing = manifest.filter(entry => !matchedIds.has(entry.id));
  assert.deepEqual(missing.map(entry => entry.id), [], `missing reviewed writer sites: ${missing.map(entry => entry.id).join(", ")}`);
  assert.equal(inventory.filter(site => !site.category).length, 0, "unclassified writer sites remain");
  return inventory;
}

function countBy(rows, key) {
  return Object.fromEntries([...new Set(rows.map(row => row[key]))].sort().map(value => [value, rows.filter(row => row[key] === value).length]));
}

function buildArtifact(serverSha256, inventory) {
  const categoryCounts = Object.fromEntries([...CLOSED_CATEGORIES].sort().map(category => [category, inventory.filter(site => site.category === category).length]));
  return {
    schema: "social-cues.hosted-writer-inventory.v1",
    source: "server.mjs",
    serverSha256,
    totalSites: inventory.length,
    primitiveCounts: countBy(inventory, "primitive"),
    categoryCounts,
    unclassified: 0,
    externalRequests: 0,
    mutations: 0,
    r4: "HOLD",
    evidencePath: ARTIFACT_PATH,
    cleanup: {
      childProcesses: 0,
      temporaryServers: 0,
      disposableMutationCopies: "in-memory-only"
    },
    sites: inventory
  };
}

function assertSafeArtifact(artifact) {
  const allowedArtifactKeys = ["categoryCounts", "cleanup", "evidencePath", "externalRequests", "mutations", "primitiveCounts", "r4", "schema", "serverSha256", "sites", "source", "totalSites", "unclassified"].sort();
  const allowedCleanupKeys = ["childProcesses", "disposableMutationCopies", "temporaryServers"].sort();
  const allowedSiteKeys = ["anchor", "category", "hostedEffect", "id", "identityProvenance", "kind", "line", "plannedPhase", "primitive"].sort();
  assert.deepEqual(Object.keys(artifact).sort(), allowedArtifactKeys);
  assert.deepEqual(Object.keys(artifact.cleanup).sort(), allowedCleanupKeys);
  for (const site of artifact.sites) {
    assert.deepEqual(Object.keys(site).sort(), allowedSiteKeys);
    assert.match(site.id, /^HW-[0-9]{3}$/);
    assert.match(site.anchor, /^sha256:[a-f0-9]{24}$/);
    assert.ok(CLOSED_CATEGORIES.has(site.category));
    assert.ok(Object.values(CATEGORY_PROFILES).some(profile => profile.hostedEffect === site.hostedEffect));
    assert.ok(Object.values(CATEGORY_PROFILES).some(profile => profile.identityProvenance === site.identityProvenance));
    assert.ok(Object.values(CATEGORY_PROFILES).some(profile => profile.plannedPhase === site.plannedPhase));
  }
  const serialized = JSON.stringify(artifact);
  assert.doesNotMatch(serialized, /\b(?:await|function|process\.env|authorization|cookie|credential|private[_ -]?key|refresh[_ -]?token|access[_ -]?token|userId|providerId)\b/i);
  assert.doesNotMatch(serialized, /(?:sk_(?:live|test)_[A-Za-z0-9]|whsec_[A-Za-z0-9]|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.|-----BEGIN [A-Z ]+PRIVATE KEY-----)/);
}

const sourceBytes = await readFile(SOURCE_URL);
const source = sourceBytes.toString("utf8").replace(/\r\n?/g, "\n");
const serverSha256 = sha256(sourceBytes);
const manifest = parseReviewedManifest();

test("all hosted writer sites match the exact reviewed manifest", () => {
  assert.ok(manifest.length > 0, "reviewed manifest is empty");
  for (const category of REQUIRED_CATEGORIES) assert.ok(CLOSED_CATEGORIES.has(category), `required category is missing: ${category}`);
  const inventory = verifyAgainstManifest(source, manifest);
  assert.equal(inventory.length, manifest.length);
  assert.deepEqual(inventory.map(site => site.id), manifest.map(entry => entry.id));
});

test("writer discovery rejects real mutations and ignores comment decoys", () => {
  assert.ok(manifest.length > 0, "reviewed manifest is empty");
  const baseline = discoverWriterSites(source).map(site => `${site.primitive}|${site.kind}|${site.digest}`);
  const knownCall = discoverWriterSites(source).find(site => site.kind === "call" && site.primitive === "saveModelForUser");
  assert.ok(knownCall);
  const removed = `${source.slice(0, knownCall.start)}saveModelForUserRemoved${source.slice(knownCall.start + "saveModelForUser".length)}`;
  assert.throws(() => verifyAgainstManifest(`${source}\nvoid saveModel(syntheticModel);\n`, manifest), /unreviewed|missing reviewed/);
  assert.throws(() => verifyAgainstManifest(removed, manifest), /unreviewed|missing reviewed/);
  assert.throws(() => verifyAgainstManifest(`${source}\nvoid saveModelForUser(\n  syntheticModel,\n  syntheticUser\n);\n`, manifest), /unreviewed|missing reviewed/);
  assert.throws(() => verifyAgainstManifest(`${source}\nconst syntheticTablePath = \"/workspace_models?select=workspace_id\";\n`, manifest), /unreviewed|missing reviewed/);
  const commentDecoy = `${source}\n// saveModel(syntheticModel); /workspace_models?select=*\n/* saveModelForUser(syntheticModel); /app_state?id=eq.primary */\n`;
  assert.deepEqual(discoverWriterSites(commentDecoy).map(site => `${site.primitive}|${site.kind}|${site.digest}`), baseline);
  assert.doesNotThrow(() => verifyAgainstManifest(commentDecoy, manifest));
});

test("inventory artifact is deterministic, bounded, ignored, and secret-safe", async () => {
  assert.ok(manifest.length > 0, "reviewed manifest is empty");
  const inventory = verifyAgainstManifest(source, manifest);
  const first = `${JSON.stringify(buildArtifact(serverSha256, inventory), null, 2)}\n`;
  const second = `${JSON.stringify(buildArtifact(serverSha256, inventory), null, 2)}\n`;
  assert.equal(second, first);
  const artifact = JSON.parse(first);
  assertSafeArtifact(artifact);
  const gitignore = (await readFile(GITIGNORE_URL, "utf8")).replace(/\r\n?/g, "\n");
  assert.match(gitignore, /(?:^|\n)\*\.log(?:\n|$)/, "inventory artifact is not covered by the committed log ignore rule");
  assert.ok(ARTIFACT_PATH.endsWith(".log"));
  await mkdir(new URL("./.tmp/", import.meta.url), { recursive: true });
  await writeFile(ARTIFACT_URL, first, "utf8");
  console.log(JSON.stringify({
    contract: artifact.schema,
    totalSites: artifact.totalSites,
    primitiveCounts: artifact.primitiveCounts,
    categoryCounts: artifact.categoryCounts,
    unclassified: artifact.unclassified,
    externalRequests: artifact.externalRequests,
    mutations: artifact.mutations,
    mutationCases: 5,
    r4: artifact.r4,
    evidencePath: artifact.evidencePath,
    cleanup: artifact.cleanup
  }));
});

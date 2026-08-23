// Strict RFC 3339 timestamp parser
const TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function parseInstant(ts) {
  if (typeof ts !== 'string' || !TIMESTAMP_REGEX.test(ts)) return null;
  const millis = Date.parse(ts);
  return Number.isNaN(millis) ? null : millis;
}

// Canonical UTF-8 byte sorter
function utf8Sort(arr) {
  return [...arr].sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
}

// Check canonical positive safe integer string: "1", "2", never "01", "-1", "0"
function isCanonicalPositiveSafeIntString(str) {
  if (typeof str !== 'string' || str.length === 0) return false;
  if (!/^[1-9]\d*$/.test(str)) return false;
  const num = Number(str);
  return Number.isSafeInteger(num) && String(num) === str;
}

function round12(num) {
  return Number(num.toFixed(12));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  }

  const body = req.body;

  // 1. Basic schema and structural validation
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    typeof body.championVersion !== 'string' ||
    !body.policy ||
    typeof body.policy !== 'object' ||
    Array.isArray(body.policy) ||
    !Array.isArray(body.versions)
  ) {
    return res.status(400).json({ error: 'INVALID_INPUT' });
  }

  const asOfMillis = parseInstant(body.asOf);
  if (asOfMillis === null) {
    return res.status(400).json({ error: 'INVALID_INPUT' });
  }

  const { policy, versions, championVersion } = body;

  // Policy validation
  let policyValid = true;
  if (
    typeof policy.datasetDigest !== 'string' || policy.datasetDigest.length === 0 ||
    typeof policy.schemaDigest !== 'string' || policy.schemaDigest.length === 0 ||
    !Number.isSafeInteger(policy.maxAgeSeconds) || policy.maxAgeSeconds < 0 ||
    typeof policy.accuracyFloor !== 'number' || !Number.isFinite(policy.accuracyFloor) || policy.accuracyFloor < 0 || policy.accuracyFloor > 1 ||
    typeof policy.maxLatencyMs !== 'number' || !Number.isFinite(policy.maxLatencyMs) || policy.maxLatencyMs < 0 ||
    !Number.isSafeInteger(policy.maxSizeBytes) || policy.maxSizeBytes < 0 ||
    typeof policy.minImprovement !== 'number' || !Number.isFinite(policy.minImprovement) || policy.minImprovement < 0 || policy.minImprovement > 1 ||
    typeof policy.requiredSlices !== 'object' || policy.requiredSlices === null || Array.isArray(policy.requiredSlices)
  ) {
    policyValid = false;
  }

  if (policyValid) {
    for (const [sliceName, floorVal] of Object.entries(policy.requiredSlices)) {
      if (
        typeof sliceName !== 'string' || sliceName.length === 0 ||
        typeof floorVal !== 'number' || !Number.isFinite(floorVal) || floorVal < 0 || floorVal > 1
      ) {
        policyValid = false;
        break;
      }
    }
  }

  // 2. Identify duplicate and noncanonical versions
  const failedGates = {};
  const versionCount = new Map();

  for (const vObj of versions) {
    const rawVersion = vObj?.version;
    if (typeof rawVersion === 'string') {
      versionCount.set(rawVersion, (versionCount.get(rawVersion) || 0) + 1);
    }
  }

  const validVersionObjects = [];

  for (const vObj of versions) {
    const rawVersion = typeof vObj?.version === 'string' ? vObj.version : String(vObj?.version ?? '');
    if (!failedGates[rawVersion]) {
      failedGates[rawVersion] = [];
    }

    let hasVersionFormatError = false;

    if (!isCanonicalPositiveSafeIntString(rawVersion)) {
      failedGates[rawVersion].push('INVALID_VERSION');
      hasVersionFormatError = true;
    }

    if (versionCount.get(rawVersion) > 1) {
      failedGates[rawVersion].push('DUPLICATE_VERSION');
      hasVersionFormatError = true;
    }

    if (!policyValid) {
      failedGates[rawVersion].push('INVALID_POLICY');
    }

    if (!hasVersionFormatError && policyValid) {
      validVersionObjects.push(vObj);
    }
  }

  // 3. Evaluate each structurally valid version against policy & gates
  const eligibleVersionsMap = new Map();

  for (const vObj of validVersionObjects) {
    const vId = vObj.version;
    const codes = failedGates[vId];
    const ev = vObj.evaluation;

    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
      codes.push('MISSING_EVALUATION');
      continue;
    }

    // Timestamps
    const createdAtMillis = parseInstant(ev.createdAt);
    if (createdAtMillis === null) {
      codes.push('INVALID_TIMESTAMP');
    } else {
      if (createdAtMillis > asOfMillis) {
        codes.push('FUTURE_EVALUATION');
      } else if (createdAtMillis < asOfMillis - policy.maxAgeSeconds * 1000) {
        codes.push('STALE_EVALUATION');
      }
    }

    // Finite Checks
    const isAccFinite = typeof ev.accuracy === 'number' && Number.isFinite(ev.accuracy);
    const isLatFinite = typeof ev.latencyMs === 'number' && Number.isFinite(ev.latencyMs);
    const isSizeFinite = typeof ev.sizeBytes === 'number' && Number.isFinite(ev.sizeBytes);

    if (!isAccFinite || !isLatFinite || !isSizeFinite) {
      codes.push('NON_FINITE');
    }

    // Metric Ranges
    if (isAccFinite && (ev.accuracy < 0 || ev.accuracy > 1)) {
      codes.push('METRIC_RANGE');
    }
    if (isLatFinite && ev.latencyMs < 0) {
      codes.push('METRIC_RANGE');
    }
    if (isSizeFinite && (!Number.isSafeInteger(ev.sizeBytes) || ev.sizeBytes < 0)) {
      codes.push('METRIC_RANGE');
    }

    // Digest Bindings
    if (typeof ev.artifactDigest !== 'string' || ev.artifactDigest !== vObj.artifactDigest) {
      codes.push('ARTIFACT_MISMATCH');
    }
    if (typeof ev.datasetDigest !== 'string' || ev.datasetDigest !== policy.datasetDigest) {
      codes.push('DATASET_MISMATCH');
    }
    if (typeof ev.schemaDigest !== 'string' || ev.schemaDigest !== policy.schemaDigest) {
      codes.push('SCHEMA_MISMATCH');
    }

    // Policy Threshold Gates
    if (isAccFinite && ev.accuracy >= 0 && ev.accuracy <= 1) {
      if (ev.accuracy < policy.accuracyFloor) {
        codes.push('ACCURACY_FLOOR');
      }
    }
    if (isLatFinite && ev.latencyMs >= 0) {
      if (ev.latencyMs > policy.maxLatencyMs) {
        codes.push('LATENCY_LIMIT');
      }
    }
    if (isSizeFinite && Number.isSafeInteger(ev.sizeBytes) && ev.sizeBytes >= 0) {
      if (ev.sizeBytes > policy.maxSizeBytes) {
        codes.push('SIZE_LIMIT');
      }
    }

    // Slices Validation
    const slices = ev.slices;
    if (!slices || typeof slices !== 'object' || Array.isArray(slices)) {
      for (const reqSlice of Object.keys(policy.requiredSlices)) {
        codes.push(`MISSING_SLICE:${reqSlice}`);
      }
    } else {
      // Validate present slice ranges
      for (const [sName, sVal] of Object.entries(slices)) {
        if (typeof sVal !== 'number' || !Number.isFinite(sVal) || sVal < 0 || sVal > 1) {
          codes.push(`SLICE_RANGE:${sName}`);
        }
      }
      // Check required slices and floors
      for (const [reqSlice, floorVal] of Object.entries(policy.requiredSlices)) {
        if (!(reqSlice in slices)) {
          codes.push(`MISSING_SLICE:${reqSlice}`);
        } else {
          const sVal = slices[reqSlice];
          if (typeof sVal === 'number' && Number.isFinite(sVal) && sVal >= 0 && sVal <= 1) {
            if (sVal < floorVal) {
              codes.push(`SLICE_FLOOR:${reqSlice}`);
            }
          }
        }
      }
    }

    if (codes.length === 0) {
      eligibleVersionsMap.set(vId, vObj);
    }
  }

  // Deduplicate and sort failedGates
  for (const vKey of Object.keys(failedGates)) {
    failedGates[vKey] = utf8Sort(Array.from(new Set(failedGates[vKey])));
  }

  // 4. Ranking Eligible Versions
  const eligibleList = Array.from(eligibleVersionsMap.values());
  eligibleList.sort((a, b) => {
    // 1. accuracy descending
    if (b.evaluation.accuracy !== a.evaluation.accuracy) {
      return b.evaluation.accuracy - a.evaluation.accuracy;
    }
    // 2. latency ascending
    if (a.evaluation.latencyMs !== b.evaluation.latencyMs) {
      return a.evaluation.latencyMs - b.evaluation.latencyMs;
    }
    // 3. size ascending
    if (a.evaluation.sizeBytes !== b.evaluation.sizeBytes) {
      return a.evaluation.sizeBytes - b.evaluation.sizeBytes;
    }
    // 4. numeric version ascending
    return Number(a.version) - Number(b.version);
  });

  const sortedEligibleVersionIds = eligibleList.map((v) => v.version);

  // 5. Decision Logic
  let action = 'retain';
  let selectedVersion = null;
  let aliasMutation = null;
  let evidence = null;

  const isChampionEligible = eligibleVersionsMap.has(championVersion);

  if (!isChampionEligible) {
    action = 'block';
    selectedVersion = null;
    evidence = null;
    aliasMutation = null;
  } else {
    const championObj = eligibleVersionsMap.get(championVersion);
    const topCandidate = eligibleList[0];

    if (topCandidate.version === championVersion) {
      action = 'retain';
      selectedVersion = championVersion;
      evidence = championObj.evaluation;
      aliasMutation = null;
    } else {
      const diff = round12(topCandidate.evaluation.accuracy - championObj.evaluation.accuracy);
      if (diff >= policy.minImprovement) {
        action = 'promote';
        selectedVersion = topCandidate.version;
        evidence = topCandidate.evaluation;
        aliasMutation = { alias: 'champion', version: topCandidate.version };
      } else {
        action = 'retain';
        selectedVersion = championVersion;
        evidence = championObj.evaluation;
        aliasMutation = null;
      }
    }
  }

  return res.status(200).json({
    action,
    championVersion,
    selectedVersion,
    eligibleVersions: sortedEligibleVersionIds,
    failedGates,
    aliasMutation,
    evidence,
  });
}
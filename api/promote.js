import { Buffer } from 'node:buffer';

const TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function parseInstant(ts) {
  if (typeof ts !== 'string' || !TIMESTAMP_REGEX.test(ts)) return null;
  const millis = Date.parse(ts);
  return Number.isNaN(millis) ? null : millis;
}

function utf8Sort(arr) {
  return [...arr].sort((a, b) => Buffer.from(String(a), 'utf8').compare(Buffer.from(String(b), 'utf8')));
}

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

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: 'INVALID_INPUT' });
    }
  } else if (Buffer.isBuffer(body)) {
    try {
      body = JSON.parse(body.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'INVALID_INPUT' });
    }
  }

  // Exact HTTP 400 conditions per contract
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    body.policy === undefined ||
    body.policy === null ||
    typeof body.policy !== 'object' ||
    Array.isArray(body.policy) ||
    !Array.isArray(body.versions) ||
    typeof body.championVersion !== 'string'
  ) {
    return res.status(400).json({ error: 'INVALID_INPUT' });
  }

  const { policy, versions, championVersion, asOf } = body;
  const asOfMillis = parseInstant(asOf);

  // 1. Validate Policy Content
  let isPolicyValid = true;
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
    isPolicyValid = false;
  }

  if (isPolicyValid) {
    for (const [sliceName, floorVal] of Object.entries(policy.requiredSlices)) {
      if (
        typeof sliceName !== 'string' || sliceName.length === 0 ||
        typeof floorVal !== 'number' || !Number.isFinite(floorVal) || floorVal < 0 || floorVal > 1
      ) {
        isPolicyValid = false;
        break;
      }
    }
  }

  // 2. Tally Version Occurrences for Duplicates
  const failedGates = {};
  const versionCount = new Map();

  for (const vObj of versions) {
    if (vObj && typeof vObj === 'object' && typeof vObj.version === 'string') {
      versionCount.set(vObj.version, (versionCount.get(vObj.version) || 0) + 1);
    }
  }

  const validVersionObjects = [];

  for (const vObj of versions) {
    const rawVersion = (vObj && typeof vObj === 'object' && typeof vObj.version === 'string')
      ? vObj.version
      : String(vObj?.version ?? '');

    if (!failedGates[rawVersion]) {
      failedGates[rawVersion] = [];
    }

    let isStructuralVersionError = false;

    if (!isCanonicalPositiveSafeIntString(rawVersion)) {
      failedGates[rawVersion].push('INVALID_VERSION');
      isStructuralVersionError = true;
    }

    if (versionCount.get(rawVersion) > 1) {
      failedGates[rawVersion].push('DUPLICATE_VERSION');
      isStructuralVersionError = true;
    }

    if (!isPolicyValid) {
      failedGates[rawVersion].push('INVALID_POLICY');
    }

    if (asOfMillis === null) {
      failedGates[rawVersion].push('INVALID_TIMESTAMP');
    }

    if (!isStructuralVersionError && isPolicyValid && asOfMillis !== null && vObj && typeof vObj === 'object') {
      validVersionObjects.push(vObj);
    }
  }

  // 3. Evaluate Version Gates
  const eligibleVersionsMap = new Map();

  for (const vObj of validVersionObjects) {
    const vId = vObj.version;
    const codes = failedGates[vId];
    const ev = vObj.evaluation;

    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
      codes.push('MISSING_EVALUATION');
      continue;
    }

    // Timestamp verification
    const createdAtMillis = parseInstant(ev.createdAt);
    if (createdAtMillis === null) {
      codes.push('INVALID_TIMESTAMP');
    } else {
      if (createdAtMillis > asOfMillis) {
        codes.push('FUTURE_EVALUATION');
      } else if (createdAtMillis < asOfMillis - (policy.maxAgeSeconds * 1000)) {
        codes.push('STALE_EVALUATION');
      }
    }

    // Metric finiteness & ranges
    const isAccFinite = typeof ev.accuracy === 'number' && Number.isFinite(ev.accuracy);
    const isLatFinite = typeof ev.latencyMs === 'number' && Number.isFinite(ev.latencyMs);
    const isSizeFinite = typeof ev.sizeBytes === 'number' && Number.isFinite(ev.sizeBytes);

    if (!isAccFinite || !isLatFinite || !isSizeFinite) {
      codes.push('NON_FINITE');
    }

    if (isAccFinite && (ev.accuracy < 0 || ev.accuracy > 1)) {
      codes.push('METRIC_RANGE');
    }
    if (isLatFinite && ev.latencyMs < 0) {
      codes.push('METRIC_RANGE');
    }
    if (isSizeFinite && (!Number.isSafeInteger(ev.sizeBytes) || ev.sizeBytes < 0)) {
      codes.push('METRIC_RANGE');
    }

    // Digest comparisons
    if (typeof ev.artifactDigest !== 'string' || ev.artifactDigest !== vObj.artifactDigest) {
      codes.push('ARTIFACT_MISMATCH');
    }
    if (typeof ev.datasetDigest !== 'string' || ev.datasetDigest !== policy.datasetDigest) {
      codes.push('DATASET_MISMATCH');
    }
    if (typeof ev.schemaDigest !== 'string' || ev.schemaDigest !== policy.schemaDigest) {
      codes.push('SCHEMA_MISMATCH');
    }

    // Aggregate policy limits
    if (isAccFinite && ev.accuracy >= 0 && ev.accuracy <= 1 && ev.accuracy < policy.accuracyFloor) {
      codes.push('ACCURACY_FLOOR');
    }
    if (isLatFinite && ev.latencyMs >= 0 && ev.latencyMs > policy.maxLatencyMs) {
      codes.push('LATENCY_LIMIT');
    }
    if (isSizeFinite && Number.isSafeInteger(ev.sizeBytes) && ev.sizeBytes >= 0 && ev.sizeBytes > policy.maxSizeBytes) {
      codes.push('SIZE_LIMIT');
    }

    // Slice checks
    const slices = ev.slices;
    if (!slices || typeof slices !== 'object' || Array.isArray(slices)) {
      for (const reqSlice of Object.keys(policy.requiredSlices)) {
        codes.push(`MISSING_SLICE:${reqSlice}`);
      }
    } else {
      for (const [sName, sVal] of Object.entries(slices)) {
        if (typeof sVal !== 'number' || !Number.isFinite(sVal) || sVal < 0 || sVal > 1) {
          codes.push(`SLICE_RANGE:${sName}`);
        }
      }
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

  // Canonical deduplicated and sorted failedGates
  for (const vKey of Object.keys(failedGates)) {
    failedGates[vKey] = utf8Sort(Array.from(new Set(failedGates[vKey])));
  }

  // 4. Ranking & Selection
  const eligibleList = Array.from(eligibleVersionsMap.values());
  eligibleList.sort((a, b) => {
    if (b.evaluation.accuracy !== a.evaluation.accuracy) return b.evaluation.accuracy - a.evaluation.accuracy;
    if (a.evaluation.latencyMs !== b.evaluation.latencyMs) return a.evaluation.latencyMs - b.evaluation.latencyMs;
    if (a.evaluation.sizeBytes !== b.evaluation.sizeBytes) return a.evaluation.sizeBytes - b.evaluation.sizeBytes;
    return Number(a.version) - Number(b.version);
  });

  const sortedEligibleVersionIds = eligibleList.map((v) => v.version);

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
export interface ClusterOptions {
  /** Hard upper bound on distinct voices. */
  maxSpeakers?: number;
  /** Minimum cosine similarity for two clusters to be considered the same voice. */
  threshold?: number;
  /**
   * Try a range of similarity thresholds and keep the split with the best
   * silhouette score. Used by the "Thorough" speaker precision mode.
   */
  autoTune?: boolean;
}

export interface ClusterResult {
  labels: number[];
  centroids: Float32Array[];
  confidence: number;
}

interface Cluster {
  indices: number[];
  centroid: Float32Array;
}

function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (let index = 0; index < vector.length; index += 1) sum += vector[index] * vector[index];
  const length = Math.sqrt(sum);
  const out = new Float32Array(vector.length);
  if (length < 1e-9) return out;
  for (let index = 0; index < vector.length; index += 1) out[index] = vector[index] / length;
  return out;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) sum += a[index] * b[index];
  return sum;
}

function meanNormalized(vectors: Float32Array[], indices: number[]): Float32Array {
  const out = new Float32Array(vectors[0]?.length ?? 0);
  for (const index of indices) {
    const vector = vectors[index];
    for (let position = 0; position < out.length; position += 1) out[position] += vector[position];
  }
  const scale = 1 / Math.max(1, indices.length);
  for (let position = 0; position < out.length; position += 1) out[position] *= scale;
  return normalize(out);
}

/**
 * Agglomerative clustering of speaker embeddings.
 *
 * Similar windows are merged until the closest pair drops below `threshold`
 * (or only `maxSpeakers` clusters remain). A final pass absorbs isolated
 * one-off windows into their nearest real speaker so a cough or a shuffled
 * chair does not become "Speaker 4".
 */
function buildClusters(vectors: Float32Array[], maxSpeakers: number, threshold: number): Cluster[] {
  const clusters: Cluster[] = vectors.map((vector, index) => ({
    indices: [index],
    centroid: vector,
  }));

  while (clusters.length > 1) {
    let bestA = 0;
    let bestB = 1;
    let bestSimilarity = -1;

    for (let a = 0; a < clusters.length; a += 1) {
      for (let b = a + 1; b < clusters.length; b += 1) {
        const similarity = cosine(clusters[a].centroid, clusters[b].centroid);
        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
          bestA = a;
          bestB = b;
        }
      }
    }

    const mustMerge = clusters.length > maxSpeakers;
    if (!mustMerge && bestSimilarity < threshold) break;

    const absorbed = clusters.splice(bestB, 1)[0];
    const target = clusters[bestA];
    target.indices.push(...absorbed.indices);
    target.centroid = meanNormalized(vectors, target.indices);
  }

  // Fold tiny outlier clusters into a nearby established speaker.
  if (clusters.length > 1 && vectors.length >= 6) {
    for (let index = clusters.length - 1; index >= 0; index -= 1) {
      const cluster = clusters[index];
      if (cluster.indices.length > 1) continue;

      let best = -1;
      let bestSimilarity = -1;
      for (let other = 0; other < clusters.length; other += 1) {
        if (other === index) continue;
        const similarity = cosine(cluster.centroid, clusters[other].centroid);
        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
          best = other;
        }
      }

      if (best >= 0 && bestSimilarity >= threshold - 0.08) {
        const target = clusters[best];
        target.indices.push(...cluster.indices);
        target.centroid = meanNormalized(vectors, target.indices);
        clusters.splice(index, 1);
      }
    }
  }

  // Largest cluster becomes Speaker 1, so the main lecturer is predictable.
  clusters.sort((a, b) => b.indices.length - a.indices.length);
  return clusters;
}

function labelsFor(count: number, clusters: Cluster[]): number[] {
  const labels = new Array<number>(count).fill(0);
  clusters.forEach((cluster, clusterIndex) => {
    for (const index of cluster.indices) labels[index] = clusterIndex;
  });
  return labels;
}

function silhouetteScore(vectors: Float32Array[], clusters: Cluster[]): number {
  if (clusters.length < 2) return 0;
  const labels = labelsFor(vectors.length, clusters);
  let total = 0;
  let counted = 0;

  for (let index = 0; index < vectors.length; index += 1) {
    const own = clusters[labels[index]].indices.filter((other) => other !== index);
    if (own.length === 0) continue;

    let intra = 0;
    for (const other of own) intra += 1 - cosine(vectors[index], vectors[other]);
    intra /= own.length;

    let nearest = Number.POSITIVE_INFINITY;
    for (let cluster = 0; cluster < clusters.length; cluster += 1) {
      if (cluster === labels[index]) continue;
      const members = clusters[cluster].indices;
      let distance = 0;
      for (const other of members) distance += 1 - cosine(vectors[index], vectors[other]);
      nearest = Math.min(nearest, distance / members.length);
    }

    const scale = Math.max(intra, nearest);
    if (scale > 1e-9) {
      total += (nearest - intra) / scale;
      counted += 1;
    }
  }

  return counted === 0 ? -1 : total / counted;
}

export function clusterEmbeddings(vectors: Float32Array[], options: ClusterOptions = {}): ClusterResult {
  const maxSpeakers = Math.max(1, Math.min(12, Math.floor(options.maxSpeakers ?? 4)));
  const threshold = Math.max(0.2, Math.min(0.95, options.threshold ?? 0.62));

  if (vectors.length === 0) return { labels: [], centroids: [], confidence: 0 };
  const usable = vectors.map((vector) => normalize(vector));
  if (usable.length === 1) {
    return { labels: [0], centroids: [usable[0]], confidence: 1 };
  }

  let clusters = buildClusters(usable, maxSpeakers, threshold);

  if (options.autoTune && usable.length >= 6) {
    let best = clusters;
    let bestScore = silhouetteScore(usable, clusters) - (clusters.length > 1 ? 0.02 * (clusters.length - 1) : 0);

    for (let candidateThreshold = 0.48; candidateThreshold <= 0.86; candidateThreshold += 0.04) {
      const candidate = buildClusters(usable, maxSpeakers, candidateThreshold);
      const score =
        silhouetteScore(usable, candidate) - (candidate.length > 1 ? 0.02 * (candidate.length - 1) : 0);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    clusters = best;
  }

  const labels = labelsFor(usable.length, clusters);

  let pairCount = 0;
  let pairSimilarity = 0;
  for (const cluster of clusters) {
    for (let a = 0; a < cluster.indices.length; a += 1) {
      for (let b = a + 1; b < cluster.indices.length; b += 1) {
        pairSimilarity += cosine(usable[cluster.indices[a]], usable[cluster.indices[b]]);
        pairCount += 1;
      }
    }
  }

  const confidence =
    pairCount === 0 ? (clusters.length === 1 ? 1 : 0.5) : Math.max(0, Math.min(1, pairSimilarity / pairCount));

  return {
    labels,
    centroids: clusters.map((cluster) => cluster.centroid),
    confidence,
  };
}

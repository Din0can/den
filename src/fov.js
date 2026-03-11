// Recursive shadowcasting FOV — ported from Kraken2004
// Reference: /tmp/kraken2004/js/map.js lines 371-424

const TRANSFORMS = [
  [1, 0, 0, 1],   // 0
  [0, 1, 1, 0],   // 1
  [0, -1, 1, 0],  // 2
  [-1, 0, 0, 1],  // 3
  [-1, 0, 0, -1], // 4
  [0, -1, -1, 0], // 5
  [0, 1, -1, 0],  // 6
  [1, 0, 0, -1],  // 7
];

function castLight(gameMap, cx, cy, radius, row, startSlope, endSlope, octant) {
  if (startSlope < endSlope) return;

  const [xx, xy, yx, yy] = TRANSFORMS[octant];
  let newStart = startSlope;

  for (let j = row; j <= radius; j++) {
    let blocked = false;

    for (let dx = -j; dx <= 0; dx++) {
      const dy = -j;

      const leftSlope = (dx - 0.5) / (dy + 0.5);
      const rightSlope = (dx + 0.5) / (dy - 0.5);

      if (startSlope < rightSlope) continue;
      if (endSlope > leftSlope) break;

      const mapX = cx + dx * xx + dy * xy;
      const mapY = cy + dx * yx + dy * yy;

      const distSq = dx * dx + dy * dy;
      if (distSq <= radius * radius) {
        gameMap.setVisible(mapX, mapY);
      }

      if (blocked) {
        if (gameMap.blocksLight(mapX, mapY)) {
          newStart = rightSlope;
        } else {
          blocked = false;
          startSlope = newStart;
        }
      } else if (gameMap.blocksLight(mapX, mapY) && j < radius) {
        blocked = true;
        castLight(gameMap, cx, cy, radius, j + 1, startSlope, leftSlope, octant);
        newStart = rightSlope;
      }
    }

    if (blocked) break;
  }
}

function applyCornerGrace(gameMap, playerX, playerY, fovRadius, graceRadius) {
  const toReveal = [];

  for (let y = Math.max(0, playerY - fovRadius - graceRadius);
       y <= Math.min(gameMap.height - 1, playerY + fovRadius + graceRadius); y++) {
    for (let x = Math.max(0, playerX - fovRadius - graceRadius);
         x <= Math.min(gameMap.width - 1, playerX + fovRadius + graceRadius); x++) {
      if (!gameMap.isVisible(x, y)) continue;

      // Check if this visible tile is at an edge (next to non-visible)
      let isEdge = false;
      for (let ddy = -1; ddy <= 1; ddy++) {
        for (let ddx = -1; ddx <= 1; ddx++) {
          if (ddx === 0 && ddy === 0) continue;
          const nx = x + ddx;
          const ny = y + ddy;
          if (nx >= 0 && nx < gameMap.width && ny >= 0 && ny < gameMap.height && !gameMap.isVisible(nx, ny)) {
            isEdge = true;
            break;
          }
        }
        if (isEdge) break;
      }

      if (!isEdge) continue;

      // Reveal nearby tiles within grace distance
      for (let dy = -graceRadius; dy <= graceRadius; dy++) {
        for (let dx = -graceRadius; dx <= graceRadius; dx++) {
          if (dx === 0 && dy === 0) continue;
          const peekX = x + dx;
          const peekY = y + dy;
          if (peekX < 0 || peekX >= gameMap.width || peekY < 0 || peekY >= gameMap.height) continue;
          if (gameMap.isVisible(peekX, peekY)) continue;

          const distFromPlayer = Math.sqrt((peekX - playerX) ** 2 + (peekY - playerY) ** 2);
          if (distFromPlayer > fovRadius + graceRadius) continue;

          if (Math.abs(dx) + Math.abs(dy) <= graceRadius) {
            toReveal.push([peekX, peekY]);
          }
        }
      }
    }
  }

  for (const [rx, ry] of toReveal) {
    gameMap.setVisible(rx, ry);
  }
}

export function calculateFOV(gameMap, playerX, playerY, radius, graceRadius) {
  gameMap.resetVisibility();
  gameMap.setVisible(playerX, playerY);

  for (let octant = 0; octant < 8; octant++) {
    castLight(gameMap, playerX, playerY, radius, 1, 1.0, 0.0, octant);
  }

  if (graceRadius > 0) {
    applyCornerGrace(gameMap, playerX, playerY, radius, graceRadius);
  }
}

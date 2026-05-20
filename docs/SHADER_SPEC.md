# Shader Design Specification

## Overview

This document specifies the GLSL shader implementations for the Space Weather Monitor visualization. All shaders are designed for optimal performance on desktop GPUs while maintaining visual fidelity.

---

## 1. Earth Shader

### Purpose
Render a realistic Earth with day/night terminator and atmospheric limb glow.

### Technique
- Diffuse texture mapping with normal maps
- Terminator calculation based on sun direction
- Fresnel-based atmospheric rim lighting

### Vertex Shader
```glsl
varying vec3 vNormal;
varying vec3 vPosition;
varying vec2 vUv;

void main() {
  vNormal = normalize(normalMatrix * normal);
  vPosition = (modelMatrix * vec4(position, 1.0)).xyz;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
```

### Fragment Shader
```glsl
uniform vec3 uSunDirection;
uniform sampler2D uDayTexture;
uniform sampler2D uNightTexture;
uniform float uAtmosphereIntensity;

varying vec3 vNormal;
varying vec3 vPosition;
varying vec2 vUv;

void main() {
  // Day/night mixing based on sun angle
  float sunDot = dot(vNormal, uSunDirection);
  float dayFactor = smoothstep(-0.2, 0.3, sunDot);
  
  vec3 dayColor = texture2D(uDayTexture, vUv).rgb;
  vec3 nightColor = texture2D(uNightTexture, vUv).rgb * 0.3;
  vec3 surfaceColor = mix(nightColor, dayColor, dayFactor);
  
  // Atmospheric rim glow (Fresnel)
  vec3 viewDirection = normalize(cameraPosition - vPosition);
  float fresnel = pow(1.0 - abs(dot(viewDirection, vNormal)), 3.0);
  vec3 atmosphereColor = vec3(0.3, 0.6, 1.0) * fresnel * uAtmosphereIntensity;
  
  gl_FragColor = vec4(surfaceColor + atmosphereColor, 1.0);
}
```

### Performance Notes
- Single texture sample per pixel
- No expensive ray operations
- Fresnel approximation is cheap

---

## 2. Van Allen Belts Shader

### Purpose
Render volumetric radiation belts with intensity modulated by particle flux data.

### Technique
- **Signed Distance Field (SDF)** for toroidal volumes
- **Limited raymarching** (max 24 steps)
- **Noise-based pulsing** for dynamic effect
- Color gradient: green → yellow → red based on intensity

### Vertex Shader
```glsl
varying vec3 vWorldPosition;
varying vec3 vLocalPosition;

void main() {
  vLocalPosition = position;
  vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
```

### Fragment Shader
```glsl
uniform float uTime;
uniform float uIntensity;      // 0-1, from particle flux
uniform float uInnerRadius;    // Inner belt: 1.5 Earth radii
uniform float uOuterRadius;    // Outer belt: 4.0 Earth radii
uniform vec3 uCameraPosition;

varying vec3 vWorldPosition;
varying vec3 vLocalPosition;

// Toroidal SDF
float sdTorus(vec3 p, float majorRadius, float minorRadius) {
  vec2 q = vec2(length(p.xz) - majorRadius, p.y);
  return length(q) - minorRadius;
}

// Simple 3D noise
float noise3D(vec3 p) {
  return fract(sin(dot(p, vec3(12.9898, 78.233, 45.164))) * 43758.5453);
}

void main() {
  vec3 rayOrigin = uCameraPosition;
  vec3 rayDir = normalize(vWorldPosition - uCameraPosition);
  
  float totalDensity = 0.0;
  vec3 accumulatedColor = vec3(0.0);
  
  // Limited raymarch (24 steps max)
  float stepSize = 0.15;
  vec3 currentPos = vWorldPosition;
  
  for (int i = 0; i < 24; i++) {
    // Inner belt SDF
    float innerDist = sdTorus(currentPos, uInnerRadius, 0.3);
    float innerDensity = exp(-innerDist * innerDist * 8.0);
    
    // Outer belt SDF
    float outerDist = sdTorus(currentPos, uOuterRadius, 0.8);
    float outerDensity = exp(-outerDist * outerDist * 4.0);
    
    // Combine with noise modulation
    float noiseVal = noise3D(currentPos * 2.0 + uTime * 0.1);
    float pulseFactor = 0.8 + 0.2 * sin(uTime * 2.0 + length(currentPos) * 3.0);
    
    float combinedDensity = (innerDensity + outerDensity) * noiseVal * pulseFactor * uIntensity;
    
    // Color based on intensity (green → yellow → red)
    vec3 beltColor = mix(
      vec3(0.2, 0.8, 0.3),  // Green (low)
      mix(
        vec3(1.0, 0.9, 0.2),  // Yellow (medium)
        vec3(1.0, 0.3, 0.1),  // Red (high)
        smoothstep(0.5, 1.0, uIntensity)
      ),
      smoothstep(0.0, 0.5, uIntensity)
    );
    
    accumulatedColor += beltColor * combinedDensity * stepSize;
    totalDensity += combinedDensity * stepSize;
    
    currentPos += rayDir * stepSize;
    
    // Early exit if saturated
    if (totalDensity > 0.95) break;
  }
  
  gl_FragColor = vec4(accumulatedColor, min(totalDensity, 0.6));
}
```

### Performance Rules
- ✅ Max 24 raymarch steps
- ✅ SDF-based (no 3D textures)
- ✅ Early exit on saturation
- ❌ No nested loops
- ❌ No per-pixel branching in inner loop

---

## 3. Magnetosphere Shader

### Purpose
Render the magnetopause boundary and magnetotail based on Shue model parameters.

### Technique
- **Parametric geometry** derived from Shue (1998) model
- **Transparency gradient** for depth
- **Tail quad strips** with shader-driven motion

### Shue Model Implementation
```glsl
// Shue et al. (1998) magnetopause model
// r = r0 * (2 / (1 + cos(theta)))^alpha
// r0: standoff distance (function of solar wind pressure)
// alpha: flaring parameter (function of Bz)

uniform float uStandoffDistance;  // r0: typically 10-12 Earth radii
uniform float uFlaringParameter;  // alpha: typically 0.5-0.6
uniform float uCompression;       // 0-1, modulates r0

float magnetopauseRadius(float theta) {
  float r0 = uStandoffDistance * (1.0 - 0.4 * uCompression);
  float alpha = uFlaringParameter;
  return r0 * pow(2.0 / (1.0 + cos(theta)), alpha);
}
```

### Vertex Shader (Magnetopause)
```glsl
uniform float uTime;
uniform float uCompression;
uniform float uReconnectionStrength;

varying vec3 vNormal;
varying float vTheta;
varying float vPhi;

void main() {
  // Parametric coordinates
  vTheta = position.x;  // 0 to PI
  vPhi = position.y;    // 0 to 2*PI
  
  // Shue model radius
  float r0 = 11.0 * (1.0 - 0.3 * uCompression);
  float alpha = 0.58;
  float r = r0 * pow(2.0 / (1.0 + cos(vTheta)), alpha);
  
  // Convert to Cartesian
  vec3 pos;
  pos.x = r * cos(vTheta);
  pos.y = r * sin(vTheta) * sin(vPhi);
  pos.z = r * sin(vTheta) * cos(vPhi);
  
  // Add subtle breathing animation
  float breathe = 1.0 + 0.02 * sin(uTime * 0.5);
  pos *= breathe;
  
  vNormal = normalize(pos);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
```

### Fragment Shader (Magnetopause)
```glsl
uniform float uReconnectionStrength;
uniform vec3 uMagnetosphereColor;

varying vec3 vNormal;
varying float vTheta;

void main() {
  // Base transparency gradient
  float alpha = 0.15 * (1.0 - vTheta / 3.14159);
  
  // Enhance near reconnection region (dayside)
  float reconnectionGlow = uReconnectionStrength * exp(-vTheta * 2.0);
  
  vec3 color = uMagnetosphereColor;
  color += vec3(0.5, 0.2, 0.8) * reconnectionGlow;
  
  gl_FragColor = vec4(color, alpha + reconnectionGlow * 0.3);
}
```

### Magnetotail Shader
```glsl
// Stretched quad strips with animated flow
uniform float uTime;
uniform float uTailStretch;  // Based on solar wind

varying vec2 vUv;

void main() {
  // Flow animation along tail
  float flow = fract(vUv.x * 0.5 - uTime * 0.1);
  float flowIntensity = smoothstep(0.0, 0.3, flow) * smoothstep(1.0, 0.7, flow);
  
  // Fade with distance
  float distanceFade = exp(-vUv.x * 0.5);
  
  vec3 tailColor = vec3(0.2, 0.4, 0.8);
  float alpha = flowIntensity * distanceFade * 0.3;
  
  gl_FragColor = vec4(tailColor, alpha);
}
```

---

## 4. Field Line Shader

### Purpose
Render magnetic field lines with instancing for performance.

### Technique
- **Instanced cylindrical curves**
- **Subtle pulsing** when Bz turns southward
- **LOD reduction** based on distance

### Vertex Shader
```glsl
attribute vec3 instanceStart;
attribute vec3 instanceEnd;
attribute float instanceIntensity;

uniform float uTime;
uniform float uReconnectionStrength;

varying float vIntensity;
varying float vProgress;

void main() {
  vProgress = position.y;  // 0-1 along line
  vIntensity = instanceIntensity;
  
  // Interpolate between start and end
  vec3 linePos = mix(instanceStart, instanceEnd, vProgress);
  
  // Add pulse animation when reconnecting
  float pulse = uReconnectionStrength * sin(uTime * 3.0 - vProgress * 6.28);
  linePos += normal * pulse * 0.05;
  
  gl_Position = projectionMatrix * modelViewMatrix * vec4(linePos, 1.0);
}
```

### Fragment Shader
```glsl
uniform float uReconnectionStrength;

varying float vIntensity;
varying float vProgress;

void main() {
  // Base field line color
  vec3 baseColor = vec3(0.3, 0.6, 1.0);
  
  // Reconnection highlight
  vec3 reconnectionColor = vec3(1.0, 0.4, 0.6);
  vec3 color = mix(baseColor, reconnectionColor, uReconnectionStrength * 0.5);
  
  // Fade at ends
  float endFade = smoothstep(0.0, 0.1, vProgress) * smoothstep(1.0, 0.9, vProgress);
  
  gl_FragColor = vec4(color, vIntensity * endFade * 0.6);
}
```

---

## Performance Guidelines

### DO
- ✅ Use SDF for volumetric effects
- ✅ Limit raymarch to 24-32 steps max
- ✅ Use instancing for repeated geometry
- ✅ Early-exit on saturation
- ✅ Pre-compute expensive operations on CPU

### DON'T
- ❌ Use 3D textures for volumes
- ❌ Nest loops deeper than 1 level
- ❌ Branch inside raymarch loops
- ❌ Per-pixel lighting on volumes
- ❌ Dynamic raymarch step counts

### Target Metrics
| Shader | Max Time |
|--------|----------|
| Earth | 1ms |
| Van Allen Belts | 5ms |
| Magnetosphere | 2ms |
| Field Lines | 1ms |
| **Total** | **< 8ms** |

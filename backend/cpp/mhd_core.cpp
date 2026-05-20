#include <iostream>
#include <vector>
#include <cmath>
#include <string>
#include <algorithm>

struct Vector3 {
    float x, y, z;
};

struct MhdState {
    float rho;
    Vector3 velocity;
    Vector3 magneticField;
};

// Physics Constants
const float MU0 = 4e-7f * M_PI;
const float RE_METERS = 6371000.0f;
const float L0_METERS = 7.0f * RE_METERS;
const float L1_DISTANCE_KM = 1500000.0f;

// Vector Utilities
inline Vector3 cross(Vector3 a, Vector3 b) {
    return {
        a.y * b.z - a.z * b.y,
        a.z * b.x - a.x * b.z,
        a.x * b.y - a.y * b.x
    };
}

inline float dot(Vector3 a, Vector3 b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}

inline float magnitude(Vector3 v) {
    return std::sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

// Core Physics Functions
float dynamicPressureNpa(float densityCm3, float speedKmS) {
    return 1.6726e-6f * densityCm3 * speedKmS * speedKmS;
}

float newellCoupling(float speedKmS, float btNt, float byNt, float bzNt) {
    float thetaClock = std::atan2(byNt, bzNt);
    float sinTerm = std::sin(thetaClock / 2.0f);
    float speedTerm = std::pow(std::max(speedKmS, 0.0f), 4.0f / 3.0f);
    float btTerm = std::pow(std::max(btNt, 0.0f), 2.0f / 3.0f);
    return speedTerm * btTerm * std::pow(std::max(sinTerm, 0.0f), 8.0f / 3.0f);
}

MhdState conservativeUpdate(const MhdState* prev, float inputRho, Vector3 inputV, Vector3 inputB) {
    if (!prev) {
        return { std::max(0.01f, inputRho), inputV, inputB };
    }

    float alpha = 0.35f;
    float rho = std::clamp(alpha * inputRho + (1.0f - alpha) * prev->rho, 0.01f, 1000.0f);
    
    Vector3 velocity = {
        alpha * inputV.x + (1.0f - alpha) * prev->velocity.x,
        alpha * inputV.y + (1.0f - alpha) * prev->velocity.y,
        alpha * inputV.z + (1.0f - alpha) * prev->velocity.z
    };
    
    Vector3 magneticField = {
        alpha * inputB.x + (1.0f - alpha) * prev->magneticField.x,
        alpha * inputB.y + (1.0f - alpha) * prev->magneticField.y,
        alpha * inputB.z + (1.0f - alpha) * prev->magneticField.z
    };

    // Divergence projection
    float divBApprox = (magneticField.x + magneticField.y + magneticField.z) / 3.0f;
    magneticField.x -= divBApprox;
    magneticField.y -= divBApprox;
    magneticField.z -= divBApprox;

    return { rho, velocity, magneticField };
}

// Node-API / WASM Export placeholders would go here.
// For now, this is the standalone C++ kernel.

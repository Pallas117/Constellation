#include <napi.h>
#include "mhd_core.cpp"

Napi::Value NativeDynamicPressure(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
        Napi::TypeError::New(env, "Number expected").ThrowAsJavaScriptException();
        return env.Null();
    }

    float density = info[0].As<Napi::Number>().FloatValue();
    float speed = info[1].As<Napi::Number>().FloatValue();
    float result = dynamicPressureNpa(density, speed);

    return Napi::Number::New(env, result);
}

Napi::Value NativeNewellCoupling(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 4) {
        Napi::TypeError::New(env, "4 arguments expected").ThrowAsJavaScriptException();
        return env.Null();
    }

    float speed = info[0].As<Napi::Number>().FloatValue();
    float bt = info[1].As<Napi::Number>().FloatValue();
    float by = info[2].As<Napi::Number>().FloatValue();
    float bz = info[3].As<Napi::Number>().FloatValue();

    float result = newellCoupling(speed, bt, by, bz);
    return Napi::Number::New(env, result);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set(Napi::String::New(env, "dynamicPressureNpa"),
                Napi::Function::New(env, NativeDynamicPressure));
    exports.Set(Napi::String::New(env, "newellCoupling"),
                Napi::Function::New(env, NativeNewellCoupling));
    return exports;
}

NODE_API_MODULE(mhd_native, Init)

// FP64 port of facetSinDelta/diffuseProfile. One thread per vehicle pair and wall cell.
// Input cell rows [x,y,tx,ty,ds], pair rows [Tx.x,Tx.y,Rx.x,Rx.y].
#include <node_api.h>
#include <cuda_runtime.h>
#include <cmath>
#include <stdexcept>
#include <string>

__global__ void weights(const double* cells, const double* pairs, int n, int jobs,
                        double denominator, double intensity, double* out) {
    int i = blockIdx.x * blockDim.x + threadIdx.x, j = blockIdx.y;
    if (i >= n || j >= jobs) return;
    const double* c = cells + 5*i; const double* p = pairs + 4*j;
    double ax=p[0]-c[0], ay=p[1]-c[1], bx=p[2]-c[0], by=p[3]-c[1];
    double ra=hypot(ax,ay), rb=hypot(bx,by), speed=hypot(c[2],c[3]);
    double ux=ax/ra, uy=ay/ra, vx=bx/rb, vy=by/rb, sine=NAN;
    if (ra>0 && rb>0 && speed>0) {
        if (ux*vx+uy*vy>=0) {
            double cross=ax*by-ay*bx, x=ux+vx, y=uy+vy;
            if (cross!=0) sine=copysign(1.0,cross)*(c[2]*x+c[3]*y)/(speed*hypot(x,y));
        } else {
            double x=vx-ux, y=vy-uy;
            sine=(c[2]*y-c[3]*x)/(speed*hypot(x,y));
        }
    }
    double w=0;
    if (fabs(sine)<1) { double q=sine*sine; w=exp(-(q/(1-q))/denominator); }
    out[(size_t)j*n+i]=intensity*w*c[4];
}
static void check(cudaError_t e) { if(e!=cudaSuccess) throw std::runtime_error(cudaGetErrorString(e)); }
struct DeviceBuffer {
    double* ptr=nullptr;
    explicit DeviceBuffer(size_t bytes) { check(cudaMalloc(&ptr,bytes)); }
    ~DeviceBuffer() { cudaFree(ptr); }
};
struct Array { double* p; size_t n; };
static Array doubles(napi_env env, napi_value arg) {
    napi_typedarray_type type; size_t n,offset; void* ptr; napi_value buffer;
    if(napi_get_typedarray_info(env,arg,&type,&n,&ptr,&buffer,&offset)!=napi_ok || type!=napi_float64_array)
        throw std::runtime_error("Expected Float64Array");
    return {static_cast<double*>(ptr),n};
}
static napi_value run(napi_env env,napi_callback_info info) {
    try {
        size_t argc=5; napi_value args[5]; napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);
        if(argc!=5) throw std::runtime_error("Expected cells, pairs, sigma, intensity, output");
        auto c=doubles(env,args[0]), p=doubles(env,args[1]), o=doubles(env,args[4]); double sigma,intensity;
        size_t n=c.n/5, j=p.n/4;
        if(!n || !j || c.n%5 || p.n%4 || n>1000000 || j>190 || o.n!=n*j ||
           napi_get_value_double(env,args[2],&sigma)!=napi_ok || !(sigma>0) ||
           napi_get_value_double(env,args[3],&intensity)!=napi_ok || !(intensity>0)) throw std::runtime_error("Invalid kernel arguments");
        DeviceBuffer cells(c.n*8), pairs(p.n*8), output(o.n*8);
        check(cudaMemcpy(cells.ptr,c.p,c.n*8,cudaMemcpyHostToDevice)); check(cudaMemcpy(pairs.ptr,p.p,p.n*8,cudaMemcpyHostToDevice));
        weights<<<dim3((n+255)/256,j),256>>>(cells.ptr,pairs.ptr,n,j,2*(sigma*sigma),intensity,output.ptr);
        check(cudaGetLastError()); check(cudaMemcpy(o.p,output.ptr,o.n*8,cudaMemcpyDeviceToHost));
        return args[4];
    } catch(const std::exception& e) { napi_throw_error(env,nullptr,e.what()); return nullptr; }
}
NAPI_MODULE_INIT() { napi_value fn; napi_create_function(env,"weights",NAPI_AUTO_LENGTH,run,nullptr,&fn); napi_set_named_property(env,exports,"weights",fn); return exports; }

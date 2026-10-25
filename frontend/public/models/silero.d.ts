import * as ort from "onnxruntime-web/wasm";
import { ModelFactory, SpeechProbabilities } from "./common";
export declare class Silero {
    private _session;
    private _state;
    private _sr;
    private ortInstance;
    private _context;
    constructor(_session: ort.InferenceSession, _state: ort.Tensor, _sr: ort.Tensor, ortInstance: typeof ort);
    static new: ModelFactory;
    reset_state: () => void;
    process: (audioFrame: Float32Array) => Promise<SpeechProbabilities>;
    release: () => Promise<void>;
}
//# sourceMappingURL=silero.d.ts.map
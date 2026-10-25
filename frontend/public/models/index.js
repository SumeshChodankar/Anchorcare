"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Silero = exports.SileroLegacy = void 0;
__exportStar(require("./common"), exports);
var legacy_1 = require("./legacy");
Object.defineProperty(exports, "SileroLegacy", { enumerable: true, get: function () { return legacy_1.SileroLegacy; } });
var silero_1 = require("./silero");
Object.defineProperty(exports, "Silero", { enumerable: true, get: function () { return silero_1.Silero; } });
//# sourceMappingURL=index.js.map
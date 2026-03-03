const colors = {
    reset: "\x1b[0m",
    bright: "\x1b[1m",
    dim: "\x1b[2m",
    underscore: "\x1b[4m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    white: "\x1b[37m",
    bgRed: "\x1b[41m",
    // ... other background colors
};

export const logger = {
    blue: (...msg: any[]) => {
        console.log(colors.blue, ...msg, colors.reset);
    },
    red: (...msg: any[]) => {
        console.log(colors.red, ...msg, colors.reset);
    },
    green: (...msg: any[]) => {
        console.log(colors.green, ...msg, colors.reset);
    },
    white: (...msg: any[]) => {
        console.log(colors.white, ...msg, colors.reset);
    },
} 
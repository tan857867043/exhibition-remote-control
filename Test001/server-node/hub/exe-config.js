const fs = require('fs');
const path = require('path');

const EXE_CONFIG_GUID = Buffer.from('B996015880544A19B7F7E9BE44914C18', 'hex');

function streamExeWithConfig(options) {
    if (!options.sourceFileName) throw new Error('sourceFileName not specified');
    if (!options.destinationStream) throw new Error('destinationStream not specified');
    if (!options.config) throw new Error('config not specified');

    const configBuf = Buffer.from(JSON.stringify(options.config), 'utf8');
    
    const sourceStream = fs.createReadStream(options.sourceFileName, { flags: 'r' });
    
    sourceStream.on('end', function() {
        options.destinationStream.write(configBuf);
        
        const lenBuf = Buffer.alloc(4);
        lenBuf.writeUInt32BE(configBuf.length, 0);
        options.destinationStream.write(lenBuf);
        
        options.destinationStream.end(EXE_CONFIG_GUID);
    });
    
    sourceStream.pipe(options.destinationStream, { end: false });
}

function getAgentFilePath() {
    const releasePath = path.join(__dirname, '..', '..', 'agent-rust', 'target', 'release', 'exhibition-agent.exe');
    const debugPath = path.join(__dirname, '..', '..', 'agent-rust', 'target', 'debug', 'exhibition-agent.exe');
    
    if (fs.existsSync(releasePath)) {
        return releasePath;
    } else if (fs.existsSync(debugPath)) {
        return debugPath;
    }
    return null;
}

module.exports = { streamExeWithConfig, getAgentFilePath, EXE_CONFIG_GUID };

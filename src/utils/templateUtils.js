/**
 * Replaces placeholders like {name} and {link} with actual data.
 */
export const injectPlaceholders = (template, data = {}) => {
    if (!template) return '';
    
    let result = template;
    
    // Replace {name} or {{name}} with data.name, data.full_name, or ''
    const participantName = data.name || data.full_name || '';
    result = result.replace(/{{name}}/g, participantName);
    result = result.replace(/{name}/g, participantName);
    
    // Replace {link} or {{link}} with data.link, data.publicUrl, or ''
    const targetLink = data.link || data.publicUrl || '';
    result = result.replace(/{{link}}/g, targetLink);
    result = result.replace(/{link}/g, targetLink);

    // Replace {number} or {{number}} with data.number or ''
    const contactNumber = data.number || '';
    result = result.replace(/{{number}}/g, contactNumber);
    result = result.replace(/{number}/g, contactNumber);
    
    return result;
};

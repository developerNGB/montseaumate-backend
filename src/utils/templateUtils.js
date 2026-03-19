/**
 * Replaces placeholders like {name} and {link} with actual data.
 */
export const injectPlaceholders = (template, data = {}) => {
    if (!template) return '';
    
    let result = template;
    
    // Replace {name} with data.name, data.full_name, or ''
    const participantName = data.name || data.full_name || '';
    result = result.replace(/{name}/g, participantName);
    
    // Replace {link} with data.link, data.publicUrl, or ''
    const targetLink = data.link || data.publicUrl || '';
    result = result.replace(/{link}/g, targetLink);
    
    return result;
};

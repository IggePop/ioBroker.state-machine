import React, { useEffect, useState } from "react";
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from "@mui/material";
import { Check as CopiedIcon, ContentCopy as CopyIcon } from "@mui/icons-material";
import { copy, I18n } from "@iobroker/adapter-react-v5";
import CodeViewer from "./CodeViewer";

/**
 * Shows the code generated from the chart
 *
 * @param {object} props
 * @param {string} props.code
 * @param {boolean} props.unsaved If the chart has unsaved changes, which are included in the code
 * @param {() => void} props.onClose
 */
export default function GeneratedCodeDialog({ code, unsaved, onClose }) {
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (!copied) {
            return undefined;
        }
        const timer = setTimeout(() => setCopied(false), 2000);
        return () => clearTimeout(timer);
    }, [copied]);

    return (
        <Dialog
            open
            onClose={onClose}
            maxWidth="lg"
            fullWidth
            slotProps={{ paper: { sx: { height: "85vh" } } }}
        >
            <DialogTitle>{I18n.t("Generated code")}</DialogTitle>
            <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
                <Typography
                    variant="body2"
                    color="text.secondary"
                >
                    {I18n.t("generatedCodeHelp")}
                    {unsaved ? ` ${I18n.t("generatedCodeUnsaved")}` : ""}
                </Typography>
                <Box sx={{ flex: 1, minHeight: 0, overflow: "auto" }}>
                    <CodeViewer value={code} />
                </Box>
            </DialogContent>
            <DialogActions>
                <Button
                    startIcon={copied ? <CopiedIcon /> : <CopyIcon />}
                    onClick={() => {
                        copy(code);
                        setCopied(true);
                    }}
                >
                    {I18n.t(copied ? "Copied" : "Copy")}
                </Button>
                <Button
                    variant="contained"
                    onClick={onClose}
                >
                    {I18n.t("Close")}
                </Button>
            </DialogActions>
        </Dialog>
    );
}

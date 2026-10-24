import React from "react";
import { Tooltip } from "@mui/material";
import { ChatBubbleOutline as CommentIcon } from "@mui/icons-material";

/**
 * Shows that an element has a comment, the comment itself is shown as tooltip
 *
 * @param {object} props
 * @param {string | undefined} props.comment
 * @param {import("@mui/material").SxProps} [props.sx]
 */
export default function CommentBadge({ comment, sx }) {
    if (!comment?.trim()) {
        return null;
    }
    return (
        <Tooltip title={<span style={{ whiteSpace: "pre-wrap" }}>{comment.trim()}</span>}>
            <CommentIcon
                sx={{ fontSize: 14, opacity: 0.7, cursor: "help", ...sx }}
                aria-label={comment}
            />
        </Tooltip>
    );
}
